require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

const app = express();
const port = process.env.PORT || 3000;

// Inisialisasi Model Gemini
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
        return { students: [] };
    }
}

function getCurrentDate() {
    return new Date().toISOString().slice(0, 10);
}

async function extractParametersFromQuery(userQuery) {
    const today = getCurrentDate();
    const prompt = `
Kamu adalah asisten AI yang bertugas menganalisis permintaan pengguna terkait absensi siswa.
Tanggal hari ini adalah: ${today}.
Ekstrak informasi berikut dari permintaan pengguna dan kembalikan dalam format JSON.
Pastikan nama bulan ditulis dengan huruf kapital di awal dan sisanya huruf kecil (contoh: "Mei", "April").
Jika tahun tidak disebutkan untuk bulan tertentu, asumsikan tahun saat ini (${new Date().getFullYear()}) atau tahun lalu jika konteksnya "bulan lalu".

1.  \`studentName\`: Nama siswa (String). Jika tidak ada, bisa \`null\` atau "semua".
2.  \`timePeriod\`: Rentang waktu (Object). Tipe bisa:
    * \`{ "type": "last_days", "days": N }\` (N adalah angka, misal "3 hari terakhir")
    * \`{ "type": "last_week" }\` (Minggu lalu: Senin-Minggu sebelum minggu berjalan)
    * \`{ "type": "current_week" }\` (Minggu ini: Senin sampai hari ini)
    * \`{ "type": "current_month" }\` (Bulan ini)
    * \`{ "type": "previous_month", "count": N }\` (N bulan lalu, N=1 untuk "bulan kemarin")
    * \`{ "type": "specific_month", "month": "NamaBulan", "year": YYYY }\` (misal "bulan April 2025")
    * \`{ "type": "specific_date", "date": "YYYY-MM-DD" }\` (misal "tanggal 15 Mei 2025")
3.  \`queryType\`: Jenis informasi (String, misal "rekap kehadiran", "jumlah hadir", "apakah hadir").

Contoh:
- Input: "Tolong rekap kehadiran Budi selama 3 hari terakhir."
  Output: { "studentName": "Budi", "timePeriod": { "type": "last_days", "days": 3 }, "queryType": "rekap kehadiran" }
- Input: "Berapa kali Ani hadir bulan April 2025?"
  Output: { "studentName": "Ani", "timePeriod": { "type": "specific_month", "month": "April", "year": 2025 }, "queryType": "jumlah hadir" }
- Input: "Bagaimana absensi semua siswa minggu lalu?"
  Output: { "studentName": "semua", "timePeriod": { "type": "last_week" }, "queryType": "rekap kehadiran" }
- Input: "Kehadiran Charlie bulan kemarin."
  Output: { "studentName": "Charlie", "timePeriod": { "type": "previous_month", "count": 1 }, "queryType": "rekap kehadiran" }
- Input: "Apakah Budi masuk tanggal 15 Mei 2025?"
  Output: { "studentName": "Budi", "timePeriod": { "type": "specific_date", "date": "2025-05-15" }, "queryType": "apakah hadir" }

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
        return JSON.parse(jsonString);
    } catch (error) {
        console.error("Error saat menghubungi Gemini untuk ekstraksi parameter:", error);
        throw new Error("Gagal memproses permintaan Anda dengan AI.");
    }
}

// Fungsi untuk mengambil dan memfilter data absensi (TELAH DIMODIFIKASI)
function getAttendanceData(studentName, timePeriod) {
    const db = readDatabase();
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    let startDate, endDate;

    switch (timePeriod.type) {
        case 'last_days':
            endDate = new Date(today);
            startDate = new Date(today);
            startDate.setDate(today.getDate() - (timePeriod.days - 1));
            break;
        case 'last_week':
            endDate = new Date(today);
            endDate.setDate(today.getDate() - today.getDay()); // Minggu lalu
            startDate = new Date(endDate);
            startDate.setDate(endDate.getDate() - 6); // Senin dari minggu lalu
            break;
        case 'current_week':
            startDate = new Date(today);
            startDate.setDate(today.getDate() - (today.getDay() - 1 + 7) % 7); // Senin minggu ini
            endDate = new Date(today);
            break;
        case 'current_month':
            startDate = new Date(today.getFullYear(), today.getMonth(), 1);
            endDate = new Date(today.getFullYear(), today.getMonth() + 1, 0);
            break;
        case 'previous_month':
            let targetMonth = today.getMonth() - timePeriod.count;
            let targetYear = today.getFullYear();
            // Handle year adjustment if targetMonth goes negative
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
            if (monthIndex === -1) throw new Error("Nama bulan tidak valid.");
            startDate = new Date(timePeriod.year, monthIndex, 1);
            endDate = new Date(timePeriod.year, monthIndex + 1, 0);
            break;
        case 'specific_date':
            // Pastikan interpretasi tanggal sebagai UTC atau lokal yang konsisten
            // Untuk menghindari masalah timezone, kita buat date object dari string YYYY-MM-DD
            // kemudian set jamnya agar tidak terpengaruh timezone saat komparasi
            const parts = timePeriod.date.split('-');
            startDate = new Date(parts[0], parts[1] - 1, parts[2]);
            endDate = new Date(parts[0], parts[1] - 1, parts[2]);
            break;
        default:
            throw new Error("Tipe periode waktu tidak dikenal.");
    }

    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(0, 0, 0, 0);

    const periodDescription = `${startDate.toISOString().slice(0,10)} hingga ${endDate.toISOString().slice(0,10)}`;
    let filteredStudentsData = [];

    const studentsToProcess = studentName && studentName.toLowerCase() !== "semua"
        ? db.students.filter(s => s.name.toLowerCase().includes(studentName.toLowerCase()))
        : db.students;

    if (studentsToProcess.length === 0 && studentName && studentName.toLowerCase() !== "semua") {
        return {
            error: `Siswa dengan nama "${studentName}" tidak ditemukan.`,
            periodDescription
        };
    }

    studentsToProcess.forEach(student => {
        const collectedRecords = [];
        let currentDateIter = new Date(startDate);

        while (currentDateIter <= endDate) {
            const yearStr = currentDateIter.getFullYear().toString();
            const monthStr = (currentDateIter.getMonth() + 1).toString().padStart(2, '0'); // "01", "02", ...
            const dayInt = currentDateIter.getDate();

            if (student.attendance &&
                student.attendance[yearStr] &&
                student.attendance[yearStr][monthStr]) {

                const monthAttendance = student.attendance[yearStr][monthStr];
                const recordForDay = monthAttendance.find(record => record.day === dayInt);

                if (recordForDay) {
                    collectedRecords.push({
                        // Rekonstruksi tanggal lengkap untuk konsistensi output
                        date: `${yearStr}-${monthStr}-${dayInt.toString().padStart(2, '0')}`,
                        status: recordForDay.status
                    });
                }
            }
            currentDateIter.setDate(currentDateIter.getDate() + 1); // Pindah ke hari berikutnya
        }

        let totalPresent = 0;
        let totalAbsent = 0;
        let totalPermission = 0;

        collectedRecords.forEach(record => {
            if (record.status.toLowerCase() === 'hadir') totalPresent++;
            else if (record.status.toLowerCase() === 'absen') totalAbsent++;
            else if (record.status.toLowerCase() === 'izin') totalPermission++;
        });

        filteredStudentsData.push({
            studentName: student.name,
            records: collectedRecords,
            summary: {
                totalPresent,
                totalAbsent,
                totalPermission,
                totalRecords: collectedRecords.length
            }
        });
    });

     if (filteredStudentsData.length > 0 && filteredStudentsData.every(s => s.records.length === 0) ) {
         // Jika ada siswa yang diproses tapi tidak ada satupun yang punya record di periode tersebut
        return {
            message: `Tidak ada data absensi untuk periode ${periodDescription} ${studentName && studentName.toLowerCase() !== "semua" ? "untuk siswa " + studentName : "untuk semua siswa"}.`,
            periodDescription
        };
    }
     if (filteredStudentsData.length === 0 && studentName && studentName.toLowerCase() === "semua") {
        // Jika query untuk semua siswa tapi tidak ada data sama sekali (misal database kosong)
         return {
            message: `Tidak ada data absensi siswa yang tersimpan.`,
            periodDescription
        };
    }


    return { data: filteredStudentsData, periodDescription };
}


async function generateNaturalResponse(originalQuery, attendanceInfo, queryType) {
    let dataForPrompt;

    if (attendanceInfo.error) {
        dataForPrompt = `Terjadi kesalahan: ${attendanceInfo.error}. Periode yang dimaksud: ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
    } else if (attendanceInfo.message) {
        dataForPrompt = `Informasi: ${attendanceInfo.message}. Periode yang dimaksud: ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
    } else if (!attendanceInfo.data || attendanceInfo.data.length === 0 || attendanceInfo.data.every(s => s.records.length === 0 && !s.summary.totalRecords)) {
         // Kondisi jika data ada tapi kosong, atau tidak ada siswa yang cocok (meskipun tidak error)
        dataForPrompt = `Tidak ditemukan data absensi yang relevan untuk permintaan Anda pada periode ${attendanceInfo.periodDescription || 'tidak spesifik'}.`;
    }
    else {
        dataForPrompt = `
Data absensi berhasil diambil.
Periode: ${attendanceInfo.periodDescription}.
Rincian:
${attendanceInfo.data.map(studentData => `
Siswa: ${studentData.studentName}
${studentData.records.length > 0 ? studentData.records.map(r => `- Tanggal ${r.date}: ${r.status}`).join('\n') : '- Tidak ada catatan absensi di periode ini.'}
Ringkasan: Hadir: ${studentData.summary.totalPresent} kali, Absen: ${studentData.summary.totalAbsent} kali, Izin: ${studentData.summary.totalPermission} kali.
`).join('\n---\n')}
`;
    }

    const prompt = `
Kamu adalah asisten AI sekolah yang ramah dan membantu. Tugasmu adalah menjawab pertanyaan orang tua mengenai absensi siswa berdasarkan data yang diberikan.
Pertanyaan asli pengguna: "${originalQuery}"
Jenis permintaan: "${queryType}"
Data yang berhasil diambil dari sistem:
${dataForPrompt}

Berikan jawaban yang jelas, ringkas, dan mudah dimengerti dalam bahasa Indonesia.
Jika ada kesalahan atau data tidak ditemukan, sampaikan dengan sopan.
Jika data ada, sajikan informasi yang relevan dengan permintaan pengguna. Misalnya jika hanya diminta jumlah hadir, fokus pada itu. Jika diminta rekap, berikan detail tanggal jika memungkinkan atau ringkasan.

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

    if (!query) {
        return res.status(400).json({ error: "Query tidak boleh kosong." });
    }

    try {
        const params = await extractParametersFromQuery(query);
        console.log("Parameter diekstrak:", params);

        // Logika tambahan untuk studentName jika diperlukan
        // (Saat ini sudah ditangani di getAttendanceData dan NLU prompt)

        const attendanceResult = getAttendanceData(params.studentName, params.timePeriod);
        console.log("Data absensi diambil:", JSON.stringify(attendanceResult, null, 2));

        const naturalResponse = await generateNaturalResponse(query, attendanceResult, params.queryType);

        res.json({
            userQuery: query,
            extractedParameters: params,
            // attendanceDataRetrieved: attendanceResult, // Untuk debug, bisa diaktifkan
            aiResponse: naturalResponse
        });

    } catch (error) {
        console.error("Error di endpoint /ask-gemini:", error);
        res.status(500).json({ error: error.message || "Terjadi kesalahan pada server." });
    }
});

app.listen(port, () => {
    console.log(`Server berjalan di http://localhost:${port}`);
    console.log(`Contoh request ke endpoint: POST http://localhost:${port}/ask-gemini dengan body JSON {"query": "rekap kehadiran Budi 3 hari terakhir"}`);
    console.log(`Tanggal hari ini (untuk referensi perhitungan): ${getCurrentDate()}`);
});