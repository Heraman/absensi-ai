require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

const MODEL_NAME = "gemini-2.0-flash";
const API_KEY = process.env.GEMINI_API_KEY;

if (!API_KEY) {
    console.error("GEMINI_API_KEY tidak ditemukan. Pastikan sudah diatur di file .env");
    process.exit(1);
}

const genAI = new GoogleGenerativeAI(API_KEY);
const model = genAI.getGenerativeModel({ model: MODEL_NAME });

const generationConfig = {
    temperature: 0.7, // Sesuaikan untuk kreativitas vs konsistensi
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
};

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    { category: HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
];

app.use(express.json());
const dbPath = path.join(__dirname, 'data', 'students.json');

function readDatabase() {
    try {
        const data = fs.readFileSync(dbPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Gagal membaca database:", error);
        return { students: [] }; // Kembalikan struktur default jika error
    }
}

function getCurrentDateWIB() {
    const now = new Date();
    // Banda Aceh adalah GMT+7 (WIB)
    // JavaScript Date.prototype.getTimezoneOffset() mengembalikan perbedaan dalam menit antara UTC dan waktu lokal.
    // Jika server di UTC, offsetnya 0. Jika server di WIB, offsetnya -420.
    // Kita inginkan tanggal seolah-olah kita berada di WIB.
    const serverTimezoneOffset = now.getTimezoneOffset(); // menit
    const wibOffsetInMinutes = -420; // GMT+7 -> -420 menit dari UTC

    // Buat tanggal baru dengan adjustment ke WIB
    // (now.getTime() adalah ms sejak epoch di UTC)
    // Tambahkan perbedaan antara offset server dan offset WIB untuk mendapatkan waktu WIB
    const wibTime = new Date(now.getTime() - (serverTimezoneOffset - wibOffsetInMinutes) * 60000);
    return wibTime.toISOString().slice(0, 10);
}

function getReferenceDateWIB() {
    const now = new Date();
    const serverTimezoneOffset = now.getTimezoneOffset();
    const wibOffsetInMinutes = -420;
    const wibTime = new Date(now.getTime() - (serverTimezoneOffset - wibOffsetInMinutes) * 60000);
    wibTime.setHours(0,0,0,0); // Normalisasi ke awal hari di WIB
    return wibTime;
}


async function extractParametersFromQuery(userQuery) {
    const todayWIB = getCurrentDateWIB(); // Tanggal referensi untuk AI
    // Misalkan hari ini adalah Senin, 19 Mei 2025
    const currentYear = new Date(todayWIB).getFullYear();

    const prompt = `
Kamu adalah asisten AI yang bertugas menganalisis permintaan pengguna terkait absensi siswa.
Tanggal hari ini adalah: ${todayWIB} (format YYYY-MM-DD, zona waktu WIB).
Ekstrak informasi berikut dari permintaan pengguna dan kembalikan dalam format JSON.
Pastikan nama bulan ditulis dengan huruf kapital di awal dan sisanya huruf kecil (contoh: "Mei", "April").
Jika tahun tidak disebutkan untuk bulan tertentu, asumsikan tahun saat ini (${currentYear}) atau tahun lalu jika konteksnya "bulan lalu".

1.  \`studentName\`: Nama siswa (String). Jika tidak ada atau "semua siswa", bisa \`null\` atau "semua".
2.  \`studentClass\`: Kelas siswa (String, misal "10A", "XI IPA 2"). Jika tidak disebutkan, kembalikan \`null\`.
3.  \`timePeriod\`: Rentang waktu (Object). Tipe bisa:
    * \`{ "type": "specific_date", "date": "YYYY-MM-DD" }\` (misal "tanggal 19 Mei 2025", "hari ini", "kemarin")
    * \`{ "type": "last_days", "days": N }\` (N adalah angka, misal "3 hari terakhir")
    * \`{ "type": "current_week" }\` (Minggu ini: Senin sampai hari ini di minggu berjalan)
    * \`{ "type": "last_week" }\` (Minggu lalu: Senin-Minggu penuh sebelum minggu berjalan)
    * \`{ "type": "current_month" }\` (Bulan ini: dari tanggal 1 sampai akhir bulan ini)
    * \`{ "type": "previous_month", "count": N }\` (N bulan lalu, N=1 untuk "bulan kemarin")
    * \`{ "type": "specific_month", "month": "NamaBulan", "year": YYYY }\` (misal "bulan April 2025")
    * \`{ "type": "current_year" }\` (Tahun ini: dari 1 Januari sampai 31 Desember tahun ini)
    * \`{ "type": "previous_year", "count": N }\` (N tahun lalu, N=1 untuk "tahun kemarin")
    * \`{ "type": "specific_year", "year": YYYY }\` (misal "tahun 2024")
4.  \`queryType\`: Jenis informasi (String, misal "rekap kehadiran", "jumlah hadir", "total absen", "jumlah izin", "apakah hadir").

Contoh:
- Input: "Tolong rekap kehadiran Budi Santoso kelas 10A selama 3 hari terakhir."
  Output: { "studentName": "Budi Santoso", "studentClass": "10A", "timePeriod": { "type": "last_days", "days": 3 }, "queryType": "rekap kehadiran" }
- Input: "Berapa kali Ani Lestari hadir bulan April 2025?"
  Output: { "studentName": "Ani Lestari", "studentClass": null, "timePeriod": { "type": "specific_month", "month": "April", "year": 2025 }, "queryType": "jumlah hadir" }
- Input: "Kehadiran Budi Santoso bulan kemarin."
  Output: { "studentName": "Budi Santoso", "studentClass": null, "timePeriod": { "type": "previous_month", "count": 1 }, "queryType": "rekap kehadiran" }
- Input: "Apakah Charlie Dharmawan kelas 10A masuk tanggal 19 Mei 2025?"
  Output: { "studentName": "Charlie Dharmawan", "studentClass": "10A", "timePeriod": { "type": "specific_date", "date": "2025-05-19" }, "queryType": "apakah hadir" }
- Input: "Total absen Budi tahun ini."
  Output: { "studentName": "Budi", "studentClass": null, "timePeriod": { "type": "current_year" }, "queryType": "total absen" }
- Input: "Rekap absensi Ani Lestari tahun 2024."
  Output: { "studentName": "Ani Lestari", "studentClass": null, "timePeriod": { "type": "specific_year", "year": 2024 }, "queryType": "rekap kehadiran" }
- Input: "Jumlah izin semua siswa tahun kemarin."
  Output: { "studentName": "semua", "studentClass": null, "timePeriod": { "type": "previous_year", "count": 1 }, "queryType": "jumlah izin" }
- Input: "absensi budi hari ini"
  Output: { "studentName": "budi", "studentClass": null, "timePeriod": { "type": "specific_date", "date": "${todayWIB}" }, "queryType": "rekap kehadiran" }


Permintaan Pengguna: "${userQuery}"
Output JSON:
`;

    try {
        const result = await model.generateContentStream([prompt]);
        let jsonString = "";
        for await (const chunk of result.stream) {
            jsonString += chunk.text();
        }
        jsonString = jsonString.replace(/```json\n?/, '').replace(/```$/, '').trim();
        // console.log("Raw JSON from AI for params:", jsonString);
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error saat menghubungi Gemini untuk ekstraksi parameter:", error);
        throw new Error("Gagal memproses permintaan Anda dengan AI untuk ekstraksi parameter.");
    }
}

function getAttendanceData(studentName, studentClass, timePeriod) {
    const db = readDatabase();
    const refDateWIB = getReferenceDateWIB(); // Tanggal referensi WIB (sudah dinormalisasi ke awal hari)

    let startDate, endDate;

    switch (timePeriod.type) {
        case 'specific_date':
            const parts = timePeriod.date.split('-');
            startDate = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
            endDate = new Date(Date.UTC(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2])));
            break;
        case 'last_days':
            endDate = new Date(refDateWIB);
            startDate = new Date(refDateWIB);
            startDate.setDate(refDateWIB.getDate() - (timePeriod.days - 1));
            break;
        case 'current_week':
            startDate = new Date(refDateWIB);
            startDate.setDate(refDateWIB.getDate() - (refDateWIB.getDay() === 0 ? 6 : refDateWIB.getDay() - 1)); // Senin minggu ini
            endDate = new Date(refDateWIB); // Sampai hari ini
            break;
        case 'last_week':
            endDate = new Date(refDateWIB);
            endDate.setDate(refDateWIB.getDate() - (refDateWIB.getDay() === 0 ? 7 : refDateWIB.getDay())); // Mundur ke hari Minggu dari minggu lalu
            startDate = new Date(endDate);
            startDate.setDate(endDate.getDate() - 6); // Mundur ke hari Senin dari minggu lalu
            break;
        case 'current_month':
            startDate = new Date(Date.UTC(refDateWIB.getFullYear(), refDateWIB.getMonth(), 1));
            endDate = new Date(Date.UTC(refDateWIB.getFullYear(), refDateWIB.getMonth() + 1, 0)); // Hari terakhir bulan ini
            break;
        case 'previous_month':
            let targetYearForPrevMonth = refDateWIB.getFullYear();
            let targetMonthIndex = refDateWIB.getMonth() - timePeriod.count;
            startDate = new Date(Date.UTC(targetYearForPrevMonth, targetMonthIndex, 1));
            endDate = new Date(Date.UTC(targetYearForPrevMonth, targetMonthIndex + 1, 0));
            break;
        case 'specific_month':
            const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
            const monthIndex = monthNames.findIndex(m => m.toLowerCase() === timePeriod.month.toLowerCase());
            if (monthIndex === -1) throw new Error(`Nama bulan tidak valid: ${timePeriod.month}`);
            startDate = new Date(Date.UTC(timePeriod.year, monthIndex, 1));
            endDate = new Date(Date.UTC(timePeriod.year, monthIndex + 1, 0));
            break;
        case 'current_year':
            startDate = new Date(Date.UTC(refDateWIB.getFullYear(), 0, 1)); // 1 Januari tahun ini
            endDate = new Date(Date.UTC(refDateWIB.getFullYear(), 11, 31)); // 31 Desember tahun ini
            break;
        case 'previous_year':
            const targetPrevYear = refDateWIB.getFullYear() - timePeriod.count;
            startDate = new Date(Date.UTC(targetPrevYear, 0, 1));
            endDate = new Date(Date.UTC(targetPrevYear, 11, 31));
            break;
        case 'specific_year':
            startDate = new Date(Date.UTC(timePeriod.year, 0, 1));
            endDate = new Date(Date.UTC(timePeriod.year, 11, 31));
            break;
        default:
            throw new Error("Tipe periode waktu tidak dikenal.");
    }
    // startDate dan endDate sudah dalam UTC dan merepresentasikan awal hari.

    const periodDescription = `${startDate.getUTCFullYear()}-${(startDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${startDate.getUTCDate().toString().padStart(2, '0')} hingga ${endDate.getUTCFullYear()}-${(endDate.getUTCMonth() + 1).toString().padStart(2, '0')}-${endDate.getUTCDate().toString().padStart(2, '0')}`;
    let filteredStudentsData = [];
    let studentsToProcess = db.students;

    if (studentName && studentName.toLowerCase() !== "semua") {
        studentsToProcess = studentsToProcess.filter(s =>
            s.name.toLowerCase().includes(studentName.toLowerCase())
        );
    }

    if (studentName && studentName.toLowerCase() !== "semua" && studentClass && studentsToProcess.length > 0) {
        const classFilteredStudents = studentsToProcess.filter(s =>
            s.class.toLowerCase() === studentClass.toLowerCase()
        );
        if (classFilteredStudents.length > 0) {
             studentsToProcess = classFilteredStudents;
        } else {
             return {
                error: `Siswa dengan nama "${studentName}" di kelas "${studentClass}" tidak ditemukan. Mungkin periksa kembali nama dan kelas.`,
                periodDescription
            };
        }
    }

    if (studentsToProcess.length === 0) {
        let message = `Siswa`;
        if (studentName && studentName.toLowerCase() !== "semua") message += ` dengan nama "${studentName}"`;
        if (studentClass) message += ` di kelas "${studentClass}"`;
        message += ` tidak ditemukan.`;
        return { error: message, periodDescription };
    }

    studentsToProcess.forEach(student => {
        const collectedRecords = [];
        // Iterasi harian dari startDate ke endDate (inklusif)
        let currentDateIter = new Date(startDate);
        while (currentDateIter <= endDate) {
            const yearStr = currentDateIter.getUTCFullYear().toString();
            const monthStr = (currentDateIter.getUTCMonth() + 1).toString().padStart(2, '0');
            const dayInt = currentDateIter.getUTCDate();

            if (student.attendance &&
                student.attendance[yearStr] &&
                student.attendance[yearStr][monthStr]) {
                const monthAttendance = student.attendance[yearStr][monthStr];
                const recordForDay = monthAttendance.find(record => record.day === dayInt);
                if (recordForDay) {
                    collectedRecords.push({
                        date: `${yearStr}-${monthStr}-${dayInt.toString().padStart(2, '0')}`,
                        status: recordForDay.status
                    });
                }
            }
            currentDateIter.setUTCDate(currentDateIter.getUTCDate() + 1);
        }

        let totalPresent = 0, totalAbsent = 0, totalPermission = 0;
        collectedRecords.forEach(record => {
            if (record.status.toLowerCase() === 'hadir') totalPresent++;
            else if (record.status.toLowerCase() === 'absen') totalAbsent++;
            else if (record.status.toLowerCase() === 'izin') totalPermission++;
        });

        filteredStudentsData.push({
            studentId: student.id,
            studentName: student.name,
            studentClass: student.class,
            records: collectedRecords,
            summary: { totalPresent, totalAbsent, totalPermission, totalRecords: collectedRecords.length }
        });
    });

    if (filteredStudentsData.every(s => s.records.length === 0)) {
        let forWhom = "semua siswa";
        if (studentName && studentName.toLowerCase() !== "semua") {
            forWhom = `siswa ${studentName}`;
            if (studentClass) forWhom += ` kelas ${studentClass}`;
        }
        return {
            message: `Tidak ada data absensi untuk periode ${periodDescription} bagi ${forWhom}.`,
            periodDescription,
            data: filteredStudentsData
        };
    }
    return { data: filteredStudentsData, periodDescription };
}

async function generateNaturalResponse(originalQuery, attendanceInfo, queryParams) {
    let dataForPrompt;
    const { studentName: queryStudentName, studentClass: queryStudentClass, timePeriod } = queryParams;
    let queryPeriodType = timePeriod ? timePeriod.type : "tidak diketahui";


    if (attendanceInfo.error) {
        dataForPrompt = `Terjadi kesalahan: ${attendanceInfo.error}. Periode yang dimaksud: ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
    } else if (attendanceInfo.message && (!attendanceInfo.data || attendanceInfo.data.every(s => s.records.length === 0))) {
        dataForPrompt = `Informasi: ${attendanceInfo.message}. Periode yang dimaksud: ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
         if (attendanceInfo.data && attendanceInfo.data.length > 0) {
            const studentDetails = attendanceInfo.data.map(s => `${s.studentName} (Kelas ${s.studentClass})`).join(', ');
            dataForPrompt += ` Siswa yang diperiksa: ${studentDetails}.`;
        }
    } else if (!attendanceInfo.data || attendanceInfo.data.length === 0 ) {
        dataForPrompt = `Tidak ditemukan data absensi yang relevan untuk permintaan Anda pada periode ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
         if(queryStudentName && queryStudentName.toLowerCase() !== 'semua') {
            dataForPrompt += ` Untuk siswa bernama "${queryStudentName}"`;
            if(queryStudentClass) dataForPrompt += ` kelas "${queryStudentClass}"`;
            dataForPrompt += ".";
        }
    } else {
        const multipleMatchesSameNameNoClass = attendanceInfo.data.length > 1 && queryStudentName && queryStudentName.toLowerCase() !== 'semua' && !queryStudentClass && attendanceInfo.data.every(s => s.studentName.toLowerCase().includes(queryStudentName.toLowerCase()));

        dataForPrompt = `
Data absensi berhasil diambil.
Periode: ${attendanceInfo.periodDescription}.
${multipleMatchesSameNameNoClass ? `Ditemukan beberapa siswa dengan nama "${queryStudentName}":` : ''}
Rincian:
${attendanceInfo.data.map(studentData => `
Siswa: ${studentData.studentName} (Kelas: ${studentData.studentClass})
${queryParams.queryType && queryParams.queryType.toLowerCase().includes("rekap") || studentData.records.length <= 10 ?
    (studentData.records.length > 0 ? studentData.records.map(r => `- Tanggal ${r.date}: ${r.status}`).join('\n') : '- Tidak ada catatan absensi di periode ini.')
    :
    (studentData.records.length > 0 ? `- Terdapat ${studentData.records.length} catatan absensi pada periode ini.` : '- Tidak ada catatan absensi di periode ini.')
}
Ringkasan: Hadir: ${studentData.summary.totalPresent} kali, Absen: ${studentData.summary.totalAbsent} kali, Izin: ${studentData.summary.totalPermission} kali.
`).join('\n---\n')}
`;
    }

    const prompt = `
Kamu adalah asisten AI sekolah yang ramah dan membantu. Tugasmu adalah menjawab pertanyaan orang tua mengenai absensi siswa berdasarkan data yang diberikan.
Pertanyaan asli pengguna: "${originalQuery}"
Parameter yang diekstrak: Nama: ${queryStudentName || 'Tidak spesifik'}, Kelas: ${queryStudentClass || 'Tidak spesifik'}, Tipe Permintaan: ${queryParams.queryType || 'Tidak spesifik'}, Jenis Periode: ${queryPeriodType}.
Data dari sistem:
${dataForPrompt}

Berikan jawaban yang jelas, ringkas, dan mudah dimengerti dalam bahasa Indonesia.
- Sampaikan periode tanggal yang dicakup oleh responsmu dengan jelas.
- Jika data detail (tanggal per tanggal) terlalu panjang (misalnya lebih dari 10 entri untuk satu siswa), cukup berikan ringkasan jumlah hadir, absen, izin, kecuali jika pengguna secara spesifik meminta "rekap".
- Jika pengguna meminta "rekap" atau data detailnya sedikit (<=10 entri), tampilkan detail tanggalnya.
- Jika ada kesalahan atau data tidak ditemukan, sampaikan dengan sopan.
- Jika ada beberapa siswa yang cocok dengan nama yang diberikan (karena kelas tidak disebutkan), sebutkan data untuk masing-masing siswa tersebut beserta kelasnya.

Jawabanmu:
`;

    try {
        const result = await model.generateContentStream([prompt]);
        let textResponse = "";
        for await (const chunk of result.stream) {
            textResponse += chunk.text();
        }
        return textResponse.trim();
    } catch (error) {
        console.error("Error saat menghubungi Gemini untuk generasi respons:", error);
        return "Maaf, terjadi kesalahan internal saat mencoba menghasilkan respons.";
    }
}

app.post('/ask-gemini', async (req, res) => {
    const { query } = req.body;
    if (!query) return res.status(400).json({ error: "Query tidak boleh kosong." });

    try {
        const params = await extractParametersFromQuery(query);
        console.log("Parameter diekstrak:", params);

        const attendanceResult = getAttendanceData(params.studentName, params.studentClass, params.timePeriod);
        // console.log("Data absensi diambil:", JSON.stringify(attendanceResult, null, 2)); // Aktifkan untuk debug detail

        const naturalResponse = await generateNaturalResponse(query, attendanceResult, params);
        res.json({
            userQuery: query,
            extractedParameters: params,
            aiResponse: naturalResponse
        });
    } catch (error) {
        console.error("Error di endpoint /ask-gemini:", error);
        res.status(500).json({ error: error.message || "Terjadi kesalahan pada server." });
    }
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
    console.log(`Tanggal referensi server (WIB): ${getCurrentDateWIB()}`);
    console.log(`Contoh request: POST http://localhost:${port}/ask-gemini dengan body JSON {"query": "rekap kehadiran Budi Santoso kelas 10A tahun ini"}`);
});