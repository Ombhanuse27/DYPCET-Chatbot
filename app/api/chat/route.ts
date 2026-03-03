import Groq from "groq-sdk";
import { Pool, PoolClient } from "pg";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.js";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";
export const maxDuration = 60;

// FIX 1: Singleton pool — max:1 caused bottlenecks under load
declare global {
  var __pgPool: Pool | undefined;
}

function getPool(): Pool {
  if (global.__pgPool) return global.__pgPool;
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    // FIX 2: Only add SSL for non-local connections
    ssl: process.env.DATABASE_URL?.includes("localhost")
      ? undefined
      : { rejectUnauthorized: false },
    // FIX 3: Raise cap for concurrent serverless invocations
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    // FIX 4: Per-query statement timeout — prevents hung queries
    statement_timeout: 15_000,
  });
  // FIX 5: Handle idle errors so process never crashes
  pool.on("error", (err) => {
    console.error("[pg-pool] idle client error:", err.message);
  });
  global.__pgPool = pool;
  return pool;
}

// FIX 6: PDF.js worker — require.resolve() breaks under webpack/Next.js
// production bundling. Use a static string or env-provided path instead.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    process.env.PDFJS_WORKER_SRC ?? "pdfjs-dist/legacy/build/pdf.worker.js";
}

// FIX 7: Logger — suppress debug/PII logs in production
const IS_PROD = process.env.NODE_ENV === "production";
const logger = {
  log: (...args: unknown[]) => { if (!IS_PROD) console.log(...args); },
  error: (...args: unknown[]) => console.error(...args),
};

// FIX 8: Safe JSON-parse — bad LLM tool-call arguments won't throw
function safeJsonParse<T = unknown>(str: string): T | null {
  try { return JSON.parse(str) as T; }
  catch { return null; }
}

// Helper: explicit client checkout so release() is guaranteed
async function dbQuery<T extends Record<string, unknown>>(
  sql: string,
  params: unknown[] = []
): Promise<T[]> {
  const pool = getPool();
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await client.query<T>(sql, params);
    return result.rows;
  } finally {
    client?.release();
  }
}

function convertToRoman(num: string): string {
  const map: Record<string, string> = {
    "1": "I", "2": "II", "3": "III", "4": "IV",
    "5": "V", "6": "VI", "7": "VII", "8": "VIII",
  };
  return map[num] ?? num;
}

// FIX 9: Replaced fs.readFileSync with async fs.promises.readFile
async function get_syllabus_from_pdf({ subject, unit }: { subject: string; unit: string }) {
  try {
    const syllabusPath = path.join(process.cwd(), "public/TY-CSE-syllabus.pdf");
    try {
      await fs.promises.access(syllabusPath, fs.constants.R_OK);
    } catch {
      throw new Error(`Syllabus file not found at ${syllabusPath}`);
    }

    const raw = await fs.promises.readFile(syllabusPath);
    const data = new Uint8Array(raw);
    const pdf = await pdfjsLib.getDocument({ data } as never).promise;

    let fullText = "";
    const pageTexts: string[] = [];

    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const items = (content.items as Array<{ transform: number[]; str: string }>).sort(
        (a, b) => {
          const yDiff = Math.abs(a.transform[5] - b.transform[5]);
          if (yDiff > 5) return b.transform[5] - a.transform[5];
          return a.transform[4] - b.transform[4];
        }
      );
      let currentY = -1, lineText = "", pageText = "";
      for (const item of items) {
        const y = item.transform[5], text = item.str;
        if (currentY !== -1 && Math.abs(currentY - y) > 5) {
          pageText += lineText.trim() + "\n";
          lineText = "";
        }
        lineText += text + " ";
        currentY = y;
      }
      pageText += lineText.trim();
      pageTexts.push(pageText);
      fullText += pageText + "\n\n";
    }

    logger.log(`Searching for: "${subject}" - Unit ${unit}`);

    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\w\s]/g, "").replace(/\s+/g, " ").trim();
    const normalizedSubject = normalize(subject);

    const subjectPatterns = [
      new RegExp(`Course\\s+Title\\s*:?\\s*${subject}`, "i"),
      new RegExp(`${subject}`, "i"),
      new RegExp(subject.split(" ").join("\\s+"), "i"),
    ];
    let subjectStartIndex = -1;
    for (const p of subjectPatterns) {
      const m = fullText.match(p);
      if (m && m.index !== undefined) { subjectStartIndex = m.index; break; }
    }
    if (subjectStartIndex === -1) {
      for (const line of fullText.split("\n")) {
        if (normalize(line).includes(normalizedSubject)) {
          subjectStartIndex = fullText.indexOf(line);
          break;
        }
      }
    }
    if (subjectStartIndex === -1) {
      return `# ❌ Subject Not Found\n\n**"${subject}"** could not be located in the syllabus database.\n\n## 💡 Suggestions:\n- **Check the spelling** of the subject name\n- Try using the **full subject name** (e.g., "Compiler Design" instead of "CD")\n- Verify this subject is part of your curriculum\n\n📝 **Tip:** You can ask "What subjects are available?" to see the complete list.`;
    }

    const afterSubject = fullText.slice(subjectStartIndex);
    const nextCourseMatch = afterSubject.slice(100).match(/Course\s+Title\s*:?/i);
    const searchableText = nextCourseMatch
      ? afterSubject.slice(0, 100 + (nextCourseMatch.index ?? 0))
      : afterSubject.slice(0, 5000);

    const unitPatterns = [
      new RegExp(`Unit[\\s-]*${unit}\\s*:([\\s\\S]+?)(?=Unit[\\s-]*(?:\\d+|[IVX]+)\\s*:|Course\\s+Outcomes|Text\\s+Books?|References?|$)`, "i"),
      new RegExp(`UNIT[\\s-]*${unit}([\\s\\S]+?)(?=UNIT[\\s-]*(?:\\d+|[IVX]+)|Course\\s+Outcomes|Text\\s+Books?|References?|$)`, "i"),
      new RegExp(`Unit[\\s-]*${convertToRoman(unit)}\\s*:?([\\s\\S]+?)(?=Unit[\\s-]*(?:\\d+|[IVX]+)|Course\\s+Outcomes|Text\\s+Books?|References?|$)`, "i"),
    ];
    let unitContent: string | null = null;
    for (const p of unitPatterns) {
      const m = searchableText.match(p);
      if (m?.[1]) { unitContent = m[1]; break; }
    }

    if (!unitContent) {
      return `# ❌ Unit Not Found\n\n**Unit ${unit}** could not be found for **${subject}**.\n\n## 💡 Common Reasons:\n- This unit may not exist for this subject\n- Most subjects have **Units 1-6**\n\n### ✅ What You Can Do:\n1. **Verify the unit number** (try 1, 2, 3, 4, 5, or 6)\n2. **Ask for another unit** from the same subject\n\n📚 Example: *"Show me Unit 1 of ${subject}"*`;
    }

    let cleanedContent = unitContent.trim()
      .replace(/\s+/g, " ")
      .replace(/(\d+)\s+Hours?/gi, "**$1 Hours**")
      .replace(/^\s*[:;-]\s*/gm, "")
      .slice(0, 2000);

    const lines = cleanedContent.split(/[,;]/).filter((l) => l.trim().length > 5);
    let formattedContent = "";
    if (lines.length > 1) {
      formattedContent = "## 📚 Topics Covered:\n\n";
      lines.forEach((line, idx) => {
        const t = line.trim();
        if (t) formattedContent += `${idx + 1}. ${t}\n`;
      });
    } else {
      formattedContent = `## 📚 Content:\n\n${cleanedContent}`;
    }

    const hoursMatch = unitContent.match(/(\d+)\s*Hours?/i);
    const hours = hoursMatch ? `\n\n⏱️ **Duration:** ${hoursMatch[1]} Hours` : "";

    return `# 📘 ${subject}\n## 🎯 Unit ${unit}\n\n${formattedContent}${hours}\n\n---\n*💡 The AI will now provide you with smart study tips and strategies for this unit!*`;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("PDF parsing error:", message);
    return `# ⚠️ Error Processing Syllabus\n\n**Something went wrong while extracting the syllabus.**\n\n## 🔍 Error Details:\n\`${message}\`\n\n## 🛠️ Troubleshooting:\n- Ensure the syllabus PDF file exists in the correct location\n- Check if the PDF is properly formatted and not corrupted\n- Try requesting a different subject or unit`;
  }
}

async function extractTextFromPDF(base64Data: string): Promise<string> {
  try {
    const buffer = Buffer.from(base64Data, "base64");
    const data = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument({ data } as never).promise;
    let fullText = "";
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      const items = (content.items as Array<{ transform: number[]; str: string }>).sort(
        (a, b) => {
          const yDiff = Math.abs(a.transform[5] - b.transform[5]);
          if (yDiff > 5) return b.transform[5] - a.transform[5];
          return a.transform[4] - b.transform[4];
        }
      );
      let currentY = -1, lineText = "", pageText = `\n--- Page ${pageNum} ---\n`;
      for (const item of items) {
        const y = item.transform[5], text = item.str;
        if (currentY !== -1 && Math.abs(currentY - y) > 5) {
          pageText += lineText.trim() + "\n";
          lineText = "";
        }
        lineText += text + " ";
        currentY = y;
      }
      pageText += lineText.trim();
      fullText += pageText + "\n";
    }
    return fullText;
  } catch (error: unknown) {
    throw new Error(`Failed to extract PDF text: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function extractTextFromPlainText(base64Data: string): string {
  return Buffer.from(base64Data, "base64").toString("utf-8");
}

// FIX 12: Validate upload size before processing
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB

async function upload_document({ documentId, fileName, fileContent, fileType }: {
  documentId: string; fileName: string; fileContent: string; fileType: string;
}) {
  try {
    logger.log(`Uploading document: ${fileName} (${fileType})`);

    // FIX 13: Reject oversized uploads early
    const estimatedBytes = Math.ceil((fileContent.length * 3) / 4);
    if (estimatedBytes > MAX_UPLOAD_BYTES) {
      return `# ❌ File Too Large\n\n**File:** ${fileName}\n\nMaximum allowed size is **5 MB**. Your file is approximately **${(estimatedBytes / 1024 / 1024).toFixed(1)} MB**.\n\n## ✅ Solutions:\n1. **Split the document** into smaller sections\n2. **Compress or reduce** the file size\n3. **Upload only the relevant pages** of the document`;
    }

    let extractedText = "";
    if (fileType === "application/pdf") {
      extractedText = await extractTextFromPDF(fileContent);
    } else if (fileType === "text/plain" || fileType === "text/markdown") {
      extractedText = extractTextFromPlainText(fileContent);
    } else {
      return `# ❌ Unsupported File Type\n\n**File Type:** \`${fileType}\`\n\n## ✅ Supported Formats:\n| Format | Extension | Description |\n|--------|-----------|-------------|\n| 📄 PDF | .pdf | Portable Document Format |\n| 📝 Text | .txt | Plain text files |\n| 📋 Markdown | .md | Markdown documents |\n\n**Please upload a file in one of the supported formats above.**`;
    }

    if (!extractedText || extractedText.trim().length === 0) {
      return `# ⚠️ Empty Document\n\n**File:** ${fileName}\n\nThe document appears to be empty or couldn't be read properly.\n\n## 🔍 Please check:\n- The file is not corrupted\n- The file actually contains text content\n- The file is not password-protected (for PDFs)\n\nTry uploading a different file or check the original document.`;
    }

    const wordCount = extractedText.split(/\s+/).filter((w: string) => w.length > 0).length;
    const isLikelyImageBased = fileType === "application/pdf" && wordCount < 10;

    if (isLikelyImageBased) {
      return `# ⚠️ Image-Based PDF Detected\n\n**File:** ${fileName}\n\nThis appears to be a **scanned or image-based PDF** (only ${wordCount} words extracted).\n\n## 🔍 Why This Happened:\n- The PDF contains images of text rather than actual text\n- Certificates, scanned documents, and some forms are often image-based\n\n## ✅ Solutions:\n1. **Use an OCR tool** to convert the PDF to text first:\n   - Adobe Acrobat (Tools → Enhance Scans → Recognize Text)\n   - Online tools: pdf2go.com, ilovepdf.com\n2. **Copy-paste the text** into a .txt file and upload that instead\n\n**Sorry for the inconvenience! This limitation is due to the document format, not an error.** 📄`;
    }

    await dbQuery(
      `INSERT INTO documents (id, file_name, content) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content, file_name = EXCLUDED.file_name`,
      [documentId, fileName, extractedText]
    );

    logger.log(`Stored document ${documentId} with ${extractedText.length} characters`);

    const lineCount = extractedText.split("\n").length;
    return `# ✅ Document Uploaded Successfully!\n\n## 📄 File Details:\n| Property | Value |\n|----------|-------|\n| **📁 File Name** | ${fileName} |\n| **📊 Characters** | ${extractedText.length.toLocaleString()} |\n| **📝 Words** | ${wordCount.toLocaleString()} |\n| **📄 Lines** | ${lineCount.toLocaleString()} |\n| **🆔 Document ID** | \`${documentId}\` |\n\n---\n\n## 💬 What's Next?\nYou can now ask me questions about this document! For example:\n- *"Summarize this document"*\n- *"What are the key points in this document?"*\n- *"Find information about [topic] in the document"*\n\n**I'm ready to help you explore the content! 🚀**`;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Document upload error:", message);
    return `# ⚠️ Upload Error\n\n**An error occurred while uploading your document.**\n\n## 🔍 Error Details:\n\`${message}\`\n\n## 🛠️ Troubleshooting Steps:\n1. **Check file size** - Very large files may cause issues\n2. **Verify file format** - Ensure it's PDF, TXT, or MD\n3. **Try re-uploading** - Sometimes a retry fixes the issue\n\nIf the problem persists, please try a different file or contact support.`;
  }
}

async function query_document({ documentId, question }: { documentId: string; question: string }) {
  try {
    logger.log(`Querying document ${documentId}`);
    const rows = await dbQuery<{ content: string; file_name: string }>(
      `SELECT content, file_name FROM documents WHERE id = $1 OR file_name = $1`,
      [documentId]
    );
    if (rows.length === 0) {
      return `# ❌ Document Not Found\n\nNo document found with ID or name: **${documentId}**\n\nPlease upload a document first.`;
    }
    const documentContent = rows[0].content;
    const wordCount = documentContent.replace(/\s+/g, " ").trim().split(/\s+/).filter((w: string) => w.length > 0).length;
    if (wordCount < 10) {
      return `# ⚠️ Cannot Answer - Insufficient Content\n\nThis document appears to contain very little extractable text.\n\nPlease upload a text-based version or use OCR.`;
    }
    const maxChars = 25_000;
    const isTruncated = documentContent.length > maxChars;
    const truncatedContent = isTruncated
      ? documentContent.slice(0, maxChars) + "\n\n[... document truncated for length ...]"
      : documentContent;
    return { content: truncatedContent, question, isTruncated, originalLength: documentContent.length };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Document query error:", message);
    return `# ⚠️ Query Error\n\n${message}`;
  }
}

async function get_attendance({ roll_number }: { roll_number: string }) {
  logger.log("get_attendance called");
  try {
    if (!roll_number || roll_number.toString().trim() === "") {
      return `# ❌ Invalid Roll Number\n\n**Please provide a valid roll number.**\n\n## 📝 Format Examples:\n- \`2021001\`\n- \`21CSE001\`\n- \`CS001\`\n\n**Enter your roll number to check attendance.**`;
    }
    const rows = await dbQuery<{ attendance_percentage: number; name: string }>(
      "SELECT attendance_percentage, name FROM students WHERE id = $1",
      [roll_number]
    );
    if (rows.length > 0) {
      const attendance = rows[0].attendance_percentage;
      const studentName = rows[0].name || "Student";
      let status = "", emoji = "", message = "";
      if (attendance >= 75) {
        status = "✅ Excellent"; emoji = "🎉"; message = "Keep up the great work!";
      } else if (attendance >= 65) {
        status = "⚠️ Warning"; emoji = "⚠️"; message = "You need to improve your attendance to meet the 75% requirement.";
      } else {
        status = "❌ Critical"; emoji = "🚨"; message = "Your attendance is critically low! Immediate improvement required.";
      }
      let improvementTip = "";
      if (attendance < 75) {
        const classesNeeded = Math.ceil(((75 - attendance) / (100 - 75)) * 10);
        improvementTip = `\n\n## 💡 Improvement Plan:\n**Attend the next ${classesNeeded}+ classes continuously** to improve your percentage.`;
      }
      return `# 📊 Attendance Report\n\n**Student:** ${studentName}  \n**Roll Number:** ${roll_number}\n\n---\n\n## ${emoji} Current Attendance\n\n| Metric | Value |\n|--------|-------|\n| **Percentage** | **${attendance}%** |\n| **Status** | ${status} |\n| **Required** | 75% (minimum) |\n\n${message}${improvementTip}\n\n---\n*📅 Keep attending classes regularly to maintain good academic standing!*`;
    } else {
      return `# ❌ Roll Number Not Found\n\n**Roll Number:** \`${roll_number}\`\n\n## 🔍 This could mean:\n- The roll number was entered incorrectly\n- You're not registered in the system yet\n\n## ✅ What to do:\n1. **Double-check your roll number**\n2. **Contact the administration** if the issue persists\n\n**Please verify and try again with the correct roll number.**`;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Error fetching attendance:", message);
    return `# ⚠️ Database Error\n\n**Unable to retrieve attendance at this moment.**\n\n## 🔧 Technical Details:\n\`${message}\`\n\n## 💡 Please Try:\n- **Wait a moment** and try again\n- **Contact support** if the issue persists`;
  }
}

async function get_timetable({ year, branch }: { year: string | number; branch: string }) {
  logger.log("get_timetable called:", year, branch);
  try {
    if (!year || !branch) {
      return `# ❌ Missing Information\n\n**Please provide both year and branch to fetch the timetable.**\n\n## 📝 Required Information:\n- **Year:** 1, 2, 3, or 4\n- **Branch:** CSE, MECH, CIVIL, etc.`;
    }
    const yearInt = Number(year);
    if (![1, 2, 3, 4].includes(yearInt)) {
      return `# ❌ Invalid Year\n\n**Year "${year}" is not valid.**\n\n## ✅ Valid Years:\n- **1** - First Year\n- **2** - Second Year\n- **3** - Third Year\n- **4** - Fourth Year`;
    }
    const rows = await dbQuery<{ day: string; time_slot: string; subject: string }>(
      "SELECT day, time_slot, subject FROM timetable WHERE year = $1 AND branch = $2 ORDER BY day, time_slot",
      [yearInt, branch]
    );
    if (rows.length > 0) {
      const yearText = ["First", "Second", "Third", "Fourth"][yearInt - 1];
      let timetableText = `# 📅 Class Timetable\n\n**Year:** ${yearText} Year  \n**Branch:** ${branch}\n\n---\n\n`;
      let currentDay = "", dayCount = 0;
      for (const { day, time_slot, subject } of rows) {
        if (day !== currentDay) {
          if (currentDay !== "") timetableText += "\n";
          timetableText += `## 📆 ${day}\n\n`;
          currentDay = day;
          dayCount++;
        }
        timetableText += `- ⏰ **${time_slot}** → ${subject}\n`;
      }
      timetableText += `\n---\n*📚 Total ${dayCount} days of classes scheduled*\n\n💡 **Tip:** Save this timetable or take a screenshot for quick reference!`;
      return timetableText;
    } else {
      const allBranches = await dbQuery<{ branch: string }>("SELECT DISTINCT branch FROM timetable WHERE year = $1", [yearInt]);
      const allYears = await dbQuery<{ year: number }>("SELECT DISTINCT year FROM timetable WHERE branch = $1", [branch]);
      let suggestionText = "";
      if (allBranches.length > 0) suggestionText += `\n\n## 📋 Available Branches for Year ${year}:\n${allBranches.map(r => r.branch).join(", ")}`;
      if (allYears.length > 0) suggestionText += `\n\n## 📋 Available Years for ${branch}:\n${allYears.map(r => r.year).join(", ")}`;
      return `# ❌ Timetable Not Found\n\n**No timetable found for:**\n- **Year:** ${year}\n- **Branch:** ${branch}${suggestionText}\n\n## ✅ What You Can Do:\n1. **Verify your year and branch**\n2. **Contact administration** if your timetable should exist`;
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error("Error fetching timetable:", message);
    return `# ⚠️ Database Error\n\n**Unable to retrieve timetable at this moment.**\n\n## 🔧 Technical Details:\n\`${message}\``;
  }
}

// FIX 14: Singleton Groq client with timeout + auto-retry
declare global {
  var __groqClient: Groq | undefined;
}
function getGroq(): Groq {
  if (global.__groqClient) return global.__groqClient;
  global.__groqClient = new Groq({
    apiKey: process.env.GROQ_API_KEY!,
    timeout: 55_000,
    maxRetries: 2,
  });
  return global.__groqClient;
}

const tools: Groq.Chat.Completions.ChatCompletionTool[] = [
  { type: "function", function: { name: "get_attendance", description: "Fetch student attendance based on roll number.", parameters: { type: "object", properties: { roll_number: { type: "string", description: "The student's roll number." } }, required: ["roll_number"] } } },
  { type: "function", function: { name: "get_timetable", description: "Fetch the class timetable based on year and branch.", parameters: { type: "object", properties: { year: { type: "integer", description: "The academic year (1-4)." }, branch: { type: "string", description: "The branch name (CSE, MECH, CIVIL, etc.)." } }, required: ["year", "branch"] } } },
  { type: "function", function: { name: "get_syllabus_from_pdf", description: "Extract unit-wise syllabus from a given subject in the syllabus PDF.", parameters: { type: "object", properties: { subject: { type: "string", description: "The subject name, e.g., 'Compiler Design'" }, unit: { type: "string", description: "The unit number, e.g., '1', '2', etc." } }, required: ["subject", "unit"] } } },
  { type: "function", function: { name: "upload_document", description: "Upload and store a document (PDF, TXT, MD) for later querying.", parameters: { type: "object", properties: { documentId: { type: "string", description: "Unique identifier for the document" }, fileName: { type: "string", description: "Name of the uploaded file" }, fileContent: { type: "string", description: "Base64 encoded file content" }, fileType: { type: "string", description: "MIME type of the file" } }, required: ["documentId", "fileName", "fileContent", "fileType"] } } },
  { type: "function", function: { name: "query_document", description: "Answer questions about a previously uploaded document. Use the documentId OR fileName from the most recent upload.", parameters: { type: "object", properties: { documentId: { type: "string", description: "The ID or fileName of the uploaded document to query" }, question: { type: "string", description: "The question to answer from the document" } }, required: ["documentId", "question"] } } },
];

const systemMessage: Groq.Chat.Completions.ChatCompletionSystemMessageParam = {
  role: "system",
  content: `You are DYPCET AI Assistant, a helpful, polite, and knowledgeable virtual assistant for Dr. D. Y. Patil College of Engineering & Technology (DYPCET).
Your job is to assist students by providing accurate and relevant information about the college.
You have access to certain tools to fetch student-specific data such as attendance and class timetable.
If the users input has some spelling mistakes, please correct them and analyse the tool use required or not.

🧠 Personality & Behavior Guidelines

- Always be polite, respectful, and professional.
- Maintain a friendly and approachable tone, suitable for interacting with college students.
- If a user asks for personal data like attendance or timetable, guide them to provide the required info (e.g., roll number, department, year).
- If a tool call is needed, extract the required information clearly and use the appropriate tool.
- If the user input is unclear, ask clarifying questions before using any tool.
- Avoid making up answers—use tool results wherever applicable.
- If a question is unrelated to the college or your capabilities, politely decline to answer and guide the user accordingly.
- Do not share or assume private data unless explicitly provided by the user.
- ⚠️ Important: When requesting timetable, always convert year to integer (1,2,3,4) and branch to exact database name ("CSE", "MECH", "CIVIL", etc.) before calling get_timetable.

⚠️ Important Database Mapping:
- If user says "CSE" or "Computer Science", use branch: "CSE"
- If user says "Mech" or "Mechanical", use branch: "MECH"
- If user says "Civil", use branch: "CIVIL"
- Ensure the branch name is always UPPERCASE when calling the tool.

Special instruction for syllabus requests:
- When the user requests a unit syllabus, after fetching it from the PDF, generate **custom study tips dynamically** based on the topics extracted.
- The study tips should include: important points to focus on, example/problem practice advice, and revision strategies.
- Make the tips concise, actionable, and relevant to the specific syllabus unit.

📄 Document Upload & Query Feature:
- Users can upload documents (PDF, TXT, MD) to ask questions about them.
- When a user uploads a document, use the upload_document tool to store it.
- When a user asks questions about their uploaded document, use the query_document tool.
- ✅ IMPORTANT: When calling query_document, use EITHER the documentId OR the fileName (whichever the user mentions or that was most recently uploaded).
- You can answer questions by analyzing the document content returned from query_document.
- CRITICAL: When answering questions about uploaded documents, ONLY use information from the uploaded document content, not from your general knowledge. If the information is not in the document, explicitly state that.
- If a document was truncated due to length, inform the user and suggest they ask more specific questions.
- ⚠️ IMAGE-BASED PDFs: If a user uploads a certificate, scanned document, or image-based PDF that has minimal text, the upload will fail with a helpful error message. DO NOT call query_document on such documents.

⚠️ CRITICAL - Tool Calling Format:
- When calling tools, use ONLY the exact function names provided: get_attendance, get_timetable, get_syllabus_from_pdf, upload_document, query_document

🎯 Handling Document Upload Confirmations:
- When a user sees a document upload confirmation message, DO NOT treat it as a question.
- Respond briefly: "Great! Your document is ready. What would you like to know about it?"
- NEVER instruct them on how to format queries with documentId - they can just ask naturally.

Stay concise, but helpful. Generate responses in proper markdown format for frontend UI rendering.`,
};

type AnyFn = (args: Record<string, unknown>) => Promise<unknown>;
const availableFunctions: Record<string, AnyFn> = {
  get_attendance: get_attendance as AnyFn,
  get_timetable: get_timetable as AnyFn,
  get_syllabus_from_pdf: get_syllabus_from_pdf as AnyFn,
  upload_document: upload_document as AnyFn,
  query_document: query_document as AnyFn,
};

// FIX 15: Null-safe rate-limit error formatter
function handleRateLimitError(error: unknown): string {
  const raw = error as { error?: { error?: { message?: string } }; message?: string };
  const errorMessage = raw?.error?.error?.message ?? raw?.message ?? (error instanceof Error ? error.message : "") ?? "";
  const timeMatch = errorMessage.match(/try again in (.+?)\./i);
  const waitTime = timeMatch?.[1] ?? "5-10 minutes";
  return `# ⏳ Rate Limit Reached\n\n**Our AI service has reached its usage limit for today.**\n\n## ⏰ Wait Time:\nPlease try again in **${waitTime}**\n\n## 💡 What You Can Do Right Now:\n\n### Option 1: Wait & Retry ⏱️\n- Come back in **${waitTime}**\n- All your data is saved\n\n### Option 2: Contact Support 📞\n- **Contact college IT support**\n- Mention the rate limit issue\n\n---\n\n## 📊 Technical Details:\n\`\`\`\n${errorMessage}\n\`\`\`\n\n**We apologize for the inconvenience! This is a temporary limit that will reset automatically.** 🙏`;
}

function errorResponse(content: string, status = 500) {
  return new Response(
    JSON.stringify({ message: { role: "assistant", content } }),
    { status, headers: { "Content-Type": "application/json" } }
  );
}

export async function POST(req: Request) {
  // FIX 16: Content-Type validation
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) {
    return errorResponse("Invalid Content-Type. Expected application/json.", 415);
  }

  // FIX 17: Safe JSON parse
  let body: {
    messages?: Array<{ role: string; content: string }>;
    documentUpload?: { documentId: string; fileName: string; fileContent: string; fileType: string };
  };
  try {
    body = await req.json();
  } catch {
    return errorResponse("Invalid JSON body.", 400);
  }

  const { messages, documentUpload } = body;

  if (documentUpload) {
    const { documentId, fileName, fileContent, fileType } = documentUpload;
    // FIX 18: Validate required fields
    if (!documentId || !fileName || !fileContent || !fileType) {
      return errorResponse("Missing required fields in documentUpload.", 400);
    }
    const result = await upload_document({ documentId, fileName, fileContent, fileType });
    return new Response(
      JSON.stringify({ message: { role: "assistant", content: result } }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  // FIX 19: Validate messages
  if (!Array.isArray(messages) || messages.length === 0) {
    return errorResponse("messages must be a non-empty array.", 400);
  }

  const userMessage = messages[messages.length - 1]?.content ?? "";
  logger.log("User input (truncated):", userMessage.slice(0, 120));

  // FIX 20: Build fresh message array per request (prevent cross-request mutation)
  const cleanedMessages = messages.map(
    (msg): Groq.Chat.Completions.ChatCompletionMessageParam => {
      if (msg.role === "assistant") return { role: "assistant", content: msg.content ?? null };
      return { role: msg.role as "user" | "system", content: msg.content };
    }
  );

  const updatedMessages: Groq.Chat.Completions.ChatCompletionMessageParam[] = [systemMessage, ...cleanedMessages];
  const groq = getGroq();

  try {
    const response = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: updatedMessages,
      tools,
      tool_choice: "auto",
      max_tokens: 4096,
    });

    const responseMessage = response.choices[0].message;
    const toolCalls = responseMessage.tool_calls;

    if (responseMessage.content) logger.log("LLM response (no tool):", responseMessage.content.slice(0, 120));
    else logger.log("LLM decided to use tools.");

    if (toolCalls && toolCalls.length > 0) {
      updatedMessages.push(responseMessage);

      for (const toolCall of toolCalls) {
        const functionName = toolCall.function.name;
        const func = availableFunctions[functionName];
        if (!func) continue;

        // FIX 21: Safe arg parse — bad LLM JSON won't throw
        const functionArgs = safeJsonParse<Record<string, unknown>>(toolCall.function.arguments) ?? {};
        const functionResponse = await func(functionArgs);
        logger.log(`Tool ${functionName} returned (truncated):`, String(functionResponse).slice(0, 200));

        const isReformatRequest = messages.length > 2 &&
          (userMessage.toLowerCase().includes("table") ||
           userMessage.toLowerCase().includes("format") ||
           userMessage.toLowerCase().includes("different") ||
           userMessage.toLowerCase().includes("show"));

        if ((functionName === "get_attendance" || functionName === "get_timetable") && !isReformatRequest) {
          return new Response(
            JSON.stringify({ message: { role: "assistant", content: functionResponse, tool_used: functionName } }),
            { headers: { "Content-Type": "application/json" } }
          );
        }

        if (functionName === "query_document") {
          if (typeof functionResponse === "object" && functionResponse !== null && "content" in functionResponse) {
            const fr = functionResponse as { content: string; question: string; isTruncated: boolean; originalLength: number };
            let contextMessage = `Based ONLY on the following document content, please answer this question: "${fr.question}"\n\nDocument Content:\n${fr.content}\n\nIMPORTANT: Only use information from the document content above. Do not use your general knowledge.`;
            if (fr.isTruncated) contextMessage += `\n\n⚠️ NOTE: This document was truncated from ${fr.originalLength.toLocaleString()} to 25,000 characters. If the answer is not found, inform the user and suggest they ask more specific questions.`;
            updatedMessages.push({ role: "user", content: contextMessage });
            try {
              const docQueryResponse = await groq.chat.completions.create({
                model: "llama-3.3-70b-versatile",
                messages: updatedMessages,
                max_tokens: 4096,
              });
              return new Response(
                JSON.stringify({ message: { role: "assistant", content: docQueryResponse.choices[0].message.content, tool_used: functionName } }),
                { headers: { "Content-Type": "application/json" } }
              );
            } catch (docError: unknown) {
              if ((docError as { status?: number })?.status === 429) {
                return new Response(JSON.stringify({ message: { role: "assistant", content: handleRateLimitError(docError) } }), { headers: { "Content-Type": "application/json" } });
              }
              throw docError;
            }
          } else {
            return new Response(
              JSON.stringify({ message: { role: "assistant", content: functionResponse, tool_used: functionName } }),
              { headers: { "Content-Type": "application/json" } }
            );
          }
        }

        updatedMessages.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: typeof functionResponse === "string" ? functionResponse : JSON.stringify(functionResponse),
        });

        if (functionName === "get_syllabus_from_pdf") {
          const syllabusContent = typeof functionResponse === "string" ? functionResponse : "";
          updatedMessages.push({
            role: "user",
            content: `Here is the syllabus that was extracted. Display this EXACT content first, then add study tips below it:\n\n${syllabusContent}\n\nNow, after displaying the above syllabus content EXACTLY as shown (with all topics), add these study guide sections below a separator line (---):\n\n## 🧠 Smart Study Strategy\n- Analyze the topics listed and identify which ones are **conceptually challenging** vs **application-based**\n- Suggest which topics typically carry more **exam weightage** \n- Recommend the **ideal study sequence** for this unit\n\n## 💡 Key Focus Areas\n- List the **3-5 most important concepts** from the topics that students should master\n- Explain **why** each concept is crucial\n- Provide **real-world applications** where relevant\n\n## 📝 Practice Recommendations\n- Suggest **specific types of problems** students should practice based on the topics\n- Recommend **2-3 practice questions** based on the topics\n- Indicate difficulty level (Easy/Medium/Hard) for each\n\n## 🔄 Revision Strategy\n- Provide a **quick revision checklist** for this unit\n- Suggest **memory techniques** or **mnemonics** if applicable\n\n## ⏱️ Time Management\n- Suggest approximate **study hours** needed for each topic\n- Recommend a **week-long study plan** for this unit\n\nIMPORTANT: Start by showing the complete syllabus content above, then add the study sections. Make it motivating and student-friendly!`,
          });
        }
      }

      try {
        const secondResponse = await groq.chat.completions.create({
          model: "llama-3.3-70b-versatile",
          messages: updatedMessages,
        });
        return new Response(
          JSON.stringify({ message: { ...secondResponse.choices[0].message, role: "assistant", tool_used: toolCalls[0].function.name } }),
          { headers: { "Content-Type": "application/json" } }
        );
      } catch (secondError: unknown) {
        if ((secondError as { status?: number })?.status === 429) {
          return new Response(JSON.stringify({ message: { role: "assistant", content: handleRateLimitError(secondError) } }), { headers: { "Content-Type": "application/json" } });
        }
        throw secondError;
      }
    } else {
      return new Response(JSON.stringify({ message: responseMessage }), { headers: { "Content-Type": "application/json" } });
    }
  } catch (error: unknown) {
    logger.error("API Error:", error);
    if ((error as { status?: number })?.status === 429) {
      return new Response(JSON.stringify({ message: { role: "assistant", content: handleRateLimitError(error) } }), { headers: { "Content-Type": "application/json" } });
    }
    const message = error instanceof Error ? error.message : "Unknown error";
    return errorResponse(`# ⚠️ Service Error\n\n**An unexpected error occurred while processing your request.**\n\n## 🔍 Error Details:\n\`${message}\`\n\n## 💡 What You Can Do:\n- **Wait a moment** and try again\n- **Simplify your question** if it was complex\n- **Contact support** if the issue persists\n\n**We apologize for the inconvenience!**`, 500);
  }
}