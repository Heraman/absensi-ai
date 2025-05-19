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
    temperature: 0.7,
    topK: 1,
    topP: 1,
    maxOutputTokens: 2048,
};

const safetySettings = [
    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
    // ... (safety settings lainnya)
];

app.use(express.json());
const dbPath = path.join(__dirname, 'data', 'students.json');

function readDatabase() {
    try {
        const data = fs.readFileSync(dbPath, 'utf-8');
        return JSON.parse(data);
    } catch (error) {
        console.error("Gagal membaca database:", error);
        return { students: [] };
    }
}

function getCurrentDate() {
    // Menggunakan Waktu Indonesia Barat (WIB) GMT+7
    const now = new Date();
    const offset = 7 * 60; // Offset WIB dalam menit
    const localNow = new Date(now.getTime() + (offset + now.getTimezoneOffset()) * 60000);
    return localNow.toISOString().slice(0, 10);
}


async function extractParametersFromQuery(userQuery) {
    const today = getCurrentDate();
    // Tanggal hari ini (Senin, 19 Mei 2025) akan digunakan AI untuk referensi relatif.
    const prompt = `
Kamu adalah asisten AI yang bertugas menganalisis permintaan pengguna terkait absensi siswa.
Tanggal hari ini adalah: ${today} (YYYY-MM-DD).
Ekstrak informasi berikut dari permintaan pengguna dan kembalikan dalam format JSON.
Pastikan nama bulan ditulis dengan huruf kapital di awal dan sisanya huruf kecil (contoh: "Mei", "April").
Jika tahun tidak disebutkan untuk bulan tertentu, asumsikan tahun saat ini (${new Date().getFullYear()}) atau tahun lalu jika konteksnya "bulan lalu".

1.  \`studentName\`: Nama siswa (String). Jika tidak ada atau "semua siswa", bisa \`null\` atau "semua".
2.  \`studentClass\`: Kelas siswa (String, misal "10A", "XI IPA 2"). Jika tidak disebutkan, kembalikan \`null\`.
3.  \`timePeriod\`: Rentang waktu (Object). Tipe bisa:
    * \`{ "type": "last_days", "days": N }\` (N adalah angka, misal "3 hari terakhir")
    * \`{ "type": "last_week" }\` (Minggu lalu: Senin-Minggu sebelum minggu berjalan)
    * \`{ "type": "current_week" }\` (Minggu ini: Senin sampai hari ini)
    * \`{ "type": "current_month" }\` (Bulan ini)
    * \`{ "type": "previous_month", "count": N }\` (N bulan lalu, N=1 untuk "bulan kemarin")
    * \`{ "type": "specific_month", "month": "NamaBulan", "year": YYYY }\` (misal "bulan April 2025")
    * \`{ "type": "specific_date", "date": "YYYY-MM-DD" }\` (misal "tanggal 19 Mei 2025")
4.  \`queryType\`: Jenis informasi (String, misal "rekap kehadiran", "jumlah hadir", "apakah hadir").

Contoh:
- Input: "Tolong rekap kehadiran Budi Santoso kelas 10A selama 3 hari terakhir."
  Output: { "studentName": "Budi Santoso", "studentClass": "10A", "timePeriod": { "type": "last_days", "days": 3 }, "queryType": "rekap kehadiran" }
- Input: "Berapa kali Ani Lestari hadir bulan April 2025?"
  Output: { "studentName": "Ani Lestari", "studentClass": null, "timePeriod": { "type": "specific_month", "month": "April", "year": 2025 }, "queryType": "jumlah hadir" }
- Input: "Kehadiran Budi Santoso bulan kemarin."
  Output: { "studentName": "Budi Santoso", "studentClass": null, "timePeriod": { "type": "previous_month", "count": 1 }, "queryType": "rekap kehadiran" }
- Input: "Apakah Charlie Dharmawan kelas 10A masuk tanggal 19 Mei 2025?"
  Output: { "studentName": "Charlie Dharmawan", "studentClass": "10A", "timePeriod": { "type": "specific_date", "date": "2025-05-19" }, "queryType": "apakah hadir" }

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
        console.log("Raw JSON from AI:", jsonString); // Debugging line
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error saat menghubungi Gemini untuk ekstraksi parameter:", error);
        console.error("String yang gagal di-parse (jika ada):", error.jsonStringOnError); // Log string jika error parsing
        throw new Error("Gagal memproses permintaan Anda dengan AI untuk ekstraksi parameter.");
    }
}

function getAttendanceData(studentName, studentClass, timePeriod) {
    const db = readDatabase();
    const today = new Date(); // Digunakan untuk perhitungan relatif
    // Normalisasi 'today' ke WIB GMT+7 jika server berjalan di timezone berbeda
    const offset = 7 * 60;
    const localToday = new Date(today.getTime() + (offset + today.getTimezoneOffset()) * 60000);
    localToday.setHours(0,0,0,0); // Normalisasi ke awal hari di WIB


    let startDate, endDate;

    // Logika penentuan startDate dan endDate (tetap sama, pastikan pakai localToday untuk referensi)
    switch (timePeriod.type) {
        case 'last_days':
            endDate = new Date(localToday);
            startDate = new Date(localToday);
            startDate.setDate(localToday.getDate() - (timePeriod.days - 1));
            break;
        case 'last_week': // Senin hingga Minggu dari minggu sebelumnya
            endDate = new Date(localToday);
            // Hari Minggu adalah 0, Senin adalah 1, ..., Sabtu adalah 6
            // Jika hari ini Minggu (0), endDate adalah hari ini. Mundur ke hari Minggu minggu lalu.
            endDate.setDate(localToday.getDate() - (localToday.getDay() === 0 ? 7 : localToday.getDay())); // Mundur ke Minggu lalu
            startDate = new Date(endDate);
            startDate.setDate(endDate.getDate() - 6); // Mundur 6 hari ke Senin
            break;
        case 'current_week': // Senin hingga hari ini dari minggu berjalan
             startDate = new Date(localToday);
            // Jika hari ini Minggu (0), maka Senin adalah 6 hari lalu. Jika Senin (1), maka Senin adalah hari ini.
            startDate.setDate(localToday.getDate() - (localToday.getDay() === 0 ? 6 : localToday.getDay() - 1));
            endDate = new Date(localToday); // Sampai hari ini
            break;
        case 'current_month':
            startDate = new Date(localToday.getFullYear(), localToday.getMonth(), 1);
            endDate = new Date(localToday.getFullYear(), localToday.getMonth() + 1, 0);
            break;
        case 'previous_month':
            let targetMonth = localToday.getMonth() - timePeriod.count;
            let targetYear = localToday.getFullYear();
            while (targetMonth < 0) {
                targetMonth += 12;
                targetYear--;
            }
            startDate = new Date(targetYear, targetMonth, 1);
            endDate = new Date(targetYear, targetMonth + 1, 0);
            break;
        case 'specific_month':
            const monthNames = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
            const monthIndex = monthNames.findIndex(m => m.toLowerCase() === timePeriod.month.toLowerCase());
            if (monthIndex === -1) throw new Error(`Nama bulan tidak valid: ${timePeriod.month}`);
            startDate = new Date(timePeriod.year, monthIndex, 1);
            endDate = new Date(timePeriod.year, monthIndex + 1, 0);
            break;
        case 'specific_date':
            const parts = timePeriod.date.split('-'); // YYYY-MM-DD
            startDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            endDate = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
            break;
        default:
            throw new Error("Tipe periode waktu tidak dikenal.");
    }

    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    const periodDescription = `${startDate.toISOString().slice(0,10)} hingga ${endDate.toISOString().slice(0,10)}`;
    let filteredStudentsData = [];
    let studentsToProcess = db.students;

    // Filter berdasarkan nama
    if (studentName && studentName.toLowerCase() !== "semua") {
        studentsToProcess = studentsToProcess.filter(s =>
            s.name.toLowerCase().includes(studentName.toLowerCase())
        );
    }

    // Jika nama ditemukan dan kelas juga disebutkan, filter lebih lanjut berdasarkan kelas
    if (studentName && studentName.toLowerCase() !== "semua" && studentClass && studentsToProcess.length > 0) {
        const classFilteredStudents = studentsToProcess.filter(s =>
            s.class.toLowerCase() === studentClass.toLowerCase()
        );
        // Hanya gunakan filter kelas jika menghasilkan sesuatu, jika tidak, mungkin kelasnya salah ketik
        // atau pengguna ingin semua dengan nama tsb jika kelasnya tidak match.
        // Untuk strict matching:
        if (classFilteredStudents.length > 0) {
             studentsToProcess = classFilteredStudents;
        } else {
            // Jika kelas disebut tapi tidak ada yg cocok dari hasil filter nama, kembalikan error
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
        let currentDateIter = new Date(startDate);

        while (currentDateIter <= endDate) {
            const yearStr = currentDateIter.getFullYear().toString();
            const monthStr = (currentDateIter.getMonth() + 1).toString().padStart(2, '0');
            const dayInt = currentDateIter.getDate();

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
            currentDateIter.setDate(currentDateIter.getDate() + 1);
        }

        let totalPresent = 0, totalAbsent = 0, totalPermission = 0;
        collectedRecords.forEach(record => {
            if (record.status.toLowerCase() === 'hadir') totalPresent++;
            else if (record.status.toLowerCase() === 'absen') totalAbsent++;
            else if (record.status.toLowerCase() === 'izin') totalPermission++;
        });

        filteredStudentsData.push({
            studentId: student.id, // Tambahkan ID untuk pembeda internal jika nama & kelas sama persis (jarang terjadi)
            studentName: student.name,
            studentClass: student.class, // Sertakan kelas siswa dalam data yang dikembalikan
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
            data: filteredStudentsData // Kirim data siswa yang relevan meskipun record kosong
        };
    }

    return { data: filteredStudentsData, periodDescription };
}

async function generateNaturalResponse(originalQuery, attendanceInfo, queryParams) {
    let dataForPrompt;
    const { studentName: queryStudentName, studentClass: queryStudentClass } = queryParams;


    if (attendanceInfo.error) {
        dataForPrompt = `Terjadi kesalahan: ${attendanceInfo.error}. Periode yang dimaksud: ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
    } else if (attendanceInfo.message && (!attendanceInfo.data || attendanceInfo.data.every(s => s.records.length === 0))) {
        // Jika ada pesan khusus (misal tidak ada data) dan memang tidak ada record
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
        dataForPrompt = `
Data absensi berhasil diambil.
Periode: ${attendanceInfo.periodDescription}.
${attendanceInfo.data.length > 1 && queryStudentName && queryStudentName.toLowerCase() !== 'semua' && !queryStudentClass ? `Ditemukan beberapa siswa dengan nama "${queryStudentName}":` : ''}
Rincian:
${attendanceInfo.data.map(studentData => `
Siswa: ${studentData.studentName} (Kelas: ${studentData.studentClass})
${studentData.records.length > 0 ? studentData.records.map(r => `- Tanggal ${r.date}: ${r.status}`).join('\n') : '- Tidak ada catatan absensi di periode ini.'}
Ringkasan: Hadir: ${studentData.summary.totalPresent} kali, Absen: ${studentData.summary.totalAbsent} kali, Izin: ${studentData.summary.totalPermission} kali.
`).join('\n---\n')}
`;
    }

    const prompt = `
Kamu adalah asisten AI sekolah yang ramah dan membantu. Tugasmu adalah menjawab pertanyaan orang tua mengenai absensi siswa berdasarkan data yang diberikan.
Pertanyaan asli pengguna: "${originalQuery}"
Parameter yang diekstrak dari pertanyaan: Nama Siswa: ${queryStudentName || 'Tidak spesifik'}, Kelas: ${queryStudentClass || 'Tidak spesifik'}.
Data yang berhasil diambil dari sistem (atau pesan kesalahan/informasi):
${dataForPrompt}

Berikan jawaban yang jelas, ringkas, dan mudah dimengerti dalam bahasa Indonesia.
- Jika ada kesalahan atau data tidak ditemukan, sampaikan dengan sopan. Jelaskan siswa atau periode mana yang tidak ada datanya.
- Jika data ada, sajikan informasi yang relevan dengan permintaan pengguna.
- Jika ada beberapa siswa yang cocok dengan nama yang diberikan (karena kelas tidak disebutkan), sebutkan data untuk masing-masing siswa tersebut beserta kelasnya.
- Sebutkan periode tanggal yang dicakup oleh responsmu.

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
        console.log("Data absensi diambil:", JSON.stringify(attendanceResult, null, 2));

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
    console.log(`Tanggal hari ini (untuk referensi perhitungan, WIB): ${getCurrentDate()}`);
    console.log(`Contoh request: POST http://localhost:${port}/ask-gemini dengan body JSON {"query": "rekap kehadiran Budi Santoso kelas 10A 3 hari terakhir"}`);
    console.log(`Contoh request (nama duplikat tanpa kelas): POST http://localhost:${port}/ask-gemini dengan body JSON {"query": "rekap kehadiran Budi Santoso minggu ini"}`);
});