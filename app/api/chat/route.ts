import Groq from "groq-sdk";
import mysql from "mysql2/promise";
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.js';
import fs from 'fs';
import path from 'path';

// ✅ FIX: This prevents PDF.js from looking for the 'canvas' module in Node.js
const PDFJS_CONFIG = {
  disableRange: true,
  disableStream: true,
  disableAutoFetch: true,
};

pdfjsLib.GlobalWorkerOptions.workerSrc = path.join(
  process.cwd(), 
  'node_modules/pdfjs-dist/legacy/build/pdf.worker.js'
);

// 📁 Store uploaded documents in memory (per session)
const documentStore = new Map<string, string>();
const documentFileNameMap = new Map<string, string>(); // Maps fileName -> documentId

export const get_syllabus_from_pdf = async ({ 
  subject, 
  unit 
}: { 
  subject: string; 
  unit: string 
}) => {
  try {
    const syllabusPath = path.join(process.cwd(), 'public/TY-CSE-syllabus.pdf');
    
    if (!fs.existsSync(syllabusPath)) {
      throw new Error(`Syllabus file not found at ${syllabusPath}`);
    }

    const data = new Uint8Array(fs.readFileSync(syllabusPath));
    const pdf = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;

    let fullText = '';
    let pageTexts: string[] = [];
    
    // Extract text with better formatting preservation
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      // Sort items by vertical position to maintain reading order
      const items = content.items.sort((a: any, b: any) => {
        const yDiff = Math.abs(a.transform[5] - b.transform[5]);
        if (yDiff > 5) return b.transform[5] - a.transform[5]; // Top to bottom
        return a.transform[4] - b.transform[4]; // Left to right
      });
      
      let currentY = -1;
      let lineText = '';
      let pageText = '';
      
      items.forEach((item: any) => {
        const y = item.transform[5];
        const text = item.str;
        
        // New line detection
        if (currentY !== -1 && Math.abs(currentY - y) > 5) {
          pageText += lineText.trim() + '\n';
          lineText = '';
        }
        
        lineText += text + ' ';
        currentY = y;
      });
      
      pageText += lineText.trim();
      pageTexts.push(pageText);
      fullText += pageText + '\n\n';
    }

    console.log(`🔍 Searching for: "${subject}" - Unit ${unit}`);

    // Normalize subject name for better matching
    const normalizeSubject = (str: string) => {
      return str.toLowerCase()
        .replace(/[^\w\s]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    };

    const normalizedSearchSubject = normalizeSubject(subject);
    
    // Try multiple subject matching patterns
    const subjectPatterns = [
      new RegExp(`Course\\s+Title\\s*:?\\s*${subject}`, 'i'),
      new RegExp(`${subject}`, 'i'),
      new RegExp(subject.split(' ').join('\\s+'), 'i'),
    ];

    let subjectStartIndex = -1;
    let matchedPattern = null;

    // Find the subject in the text
    for (const pattern of subjectPatterns) {
      const match = fullText.match(pattern);
      if (match) {
        subjectStartIndex = match.index!;
        matchedPattern = pattern;
        break;
      }
    }

    if (subjectStartIndex === -1) {
      // Try fuzzy matching on each line
      const lines = fullText.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (normalizeSubject(lines[i]).includes(normalizedSearchSubject)) {
          subjectStartIndex = fullText.indexOf(lines[i]);
          break;
        }
      }
    }

    if (subjectStartIndex === -1) {
      return `❌ **Subject "${subject}" not found** in the syllabus.\n\n💡 **Tip:** Try checking the exact subject name or browse the available subjects.`;
    }

    // Extract content after subject match
    const afterSubject = fullText.slice(subjectStartIndex);
    
    // Find the next subject/course to limit our search
    const nextCourseMatch = afterSubject.slice(100).match(/Course\s+Title\s*:?/i);
    const searchableText = nextCourseMatch 
      ? afterSubject.slice(0, 100 + nextCourseMatch.index!)
      : afterSubject.slice(0, 5000);

    // Multiple unit matching patterns
    const unitPatterns = [
      // Pattern 1: "Unit 1:" or "Unit I:"
      new RegExp(
        `Unit[\\s-]*${unit}\\s*:([\\s\\S]+?)(?=Unit[\\s-]*(?:\\d+|[IVX]+)\\s*:|Course\\s+Outcomes|Text\\s+Books?|References?|$)`,
        'i'
      ),
      // Pattern 2: "UNIT 1" or "UNIT-1"
      new RegExp(
        `UNIT[\\s-]*${unit}([\\s\\S]+?)(?=UNIT[\\s-]*(?:\\d+|[IVX]+)|Course\\s+Outcomes|Text\\s+Books?|References?|$)`,
        'i'
      ),
      // Pattern 3: Roman numerals (I, II, III, IV, V, VI)
      new RegExp(
        `Unit[\\s-]*${convertToRoman(unit)}\\s*:?([\\s\\S]+?)(?=Unit[\\s-]*(?:\\d+|[IVX]+)|Course\\s+Outcomes|Text\\s+Books?|References?|$)`,
        'i'
      ),
    ];

    let unitContent = null;
    let matchedUnitPattern = null;

    for (const pattern of unitPatterns) {
      const match = searchableText.match(pattern);
      if (match && match[1]) {
        unitContent = match[1];
        matchedUnitPattern = pattern;
        break;
      }
    }

    if (!unitContent) {
      return `❌ **Unit ${unit} not found** for ${subject}.\n\n💡 **Available units:** Usually 1-6. Please verify the unit number.`;
    }

    // Clean and format the content
    let cleanedContent = unitContent
      .trim()
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/(\d+)\s+Hours?/gi, '**$1 Hours**') // Bold hours
      .replace(/^\s*[:;-]\s*/gm, '') // Remove leading punctuation
      .slice(0, 2000); // Limit length

    // Try to extract topics/subtopics
    const lines = cleanedContent.split(/[,;]/).filter(l => l.trim().length > 5);
    
    let formattedContent = '';
    if (lines.length > 1) {
      formattedContent = '**Topics Covered:**\n\n';
      lines.forEach((line, idx) => {
        const trimmedLine = line.trim();
        if (trimmedLine) {
          formattedContent += `${idx + 1}. ${trimmedLine}\n`;
        }
      });
    } else {
      formattedContent = cleanedContent;
    }

    // Extract hours if present
    const hoursMatch = unitContent.match(/(\d+)\s*Hours?/i);
    const hours = hoursMatch ? `\n\n⏱️ **Duration:** ${hoursMatch[1]} Hours` : '';

    return `# 📘 ${subject}\n## Unit ${unit}\n\n${formattedContent}${hours}`;
    
  } catch (err: any) {
    console.error('PDF parsing error:', err);
    return `⚠️ **Error processing PDF:** ${err.message}\n\nPlease ensure the syllabus file is properly formatted.`;
  }
};

// Helper function to convert numbers to Roman numerals
function convertToRoman(num: string): string {
  const romanNumerals: { [key: string]: string } = {
    '1': 'I', '2': 'II', '3': 'III', '4': 'IV',
    '5': 'V', '6': 'VI', '7': 'VII', '8': 'VIII'
  };
  return romanNumerals[num] || num;
}

// 📄 Extract text from uploaded PDF
async function extractTextFromPDF(base64Data: string): Promise<string> {
  try {
    const buffer = Buffer.from(base64Data, 'base64');
    const data = new Uint8Array(buffer);
    const pdf = await pdfjsLib.getDocument({ data, disableWorker: true }).promise;

    let fullText = '';
    
    for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const content = await page.getTextContent();
      
      const items = content.items.sort((a: any, b: any) => {
        const yDiff = Math.abs(a.transform[5] - b.transform[5]);
        if (yDiff > 5) return b.transform[5] - a.transform[5];
        return a.transform[4] - b.transform[4];
      });
      
      let currentY = -1;
      let lineText = '';
      let pageText = `\n--- Page ${pageNum} ---\n`;
      
      items.forEach((item: any) => {
        const y = item.transform[5];
        const text = item.str;
        
        if (currentY !== -1 && Math.abs(currentY - y) > 5) {
          pageText += lineText.trim() + '\n';
          lineText = '';
        }
        
        lineText += text + ' ';
        currentY = y;
      });
      
      pageText += lineText.trim();
      fullText += pageText + '\n';
    }

    return fullText;
  } catch (error: any) {
    throw new Error(`Failed to extract PDF text: ${error.message}`);
  }
}

// 📝 Extract text from TXT/MD files
function extractTextFromPlainText(base64Data: string): string {
  const buffer = Buffer.from(base64Data, 'base64');
  return buffer.toString('utf-8');
}

// 🆕 Upload and store document
async function upload_document({ 
  documentId, 
  fileName, 
  fileContent, 
  fileType 
}: any) {
  try {
    console.log(`📤 Uploading document: ${fileName} (${fileType})`);
    
    let extractedText = '';

    if (fileType === 'application/pdf') {
      extractedText = await extractTextFromPDF(fileContent);
    } else if (fileType === 'text/plain' || fileType === 'text/markdown') {
      extractedText = extractTextFromPlainText(fileContent);
    } else {
      return `❌ **Unsupported file type**: ${fileType}\n\n✅ **Supported formats**: PDF, TXT, MD`;
    }

    // Store in memory with documentId as key
    documentStore.set(documentId, extractedText);
    
    // ✅ FIX: Also map fileName to documentId for easy lookup
    documentFileNameMap.set(fileName, documentId);

    console.log(`✅ Stored document ${documentId} with ${extractedText.length} characters`);
    console.log(`📝 Mapped fileName "${fileName}" -> documentId "${documentId}"`);

    return `✅ **Document uploaded successfully!**\n\n📄 **File**: ${fileName}\n📊 **Characters**: ${extractedText.length}\n\n💬 You can now ask questions about this document!`;
  } catch (error: any) {
    console.error('Document upload error:', error);
    return `⚠️ **Error uploading document:** ${error.message}`;
  }
}

// 🆕 Query uploaded document
async function query_document({ documentId, question }: any) {
  try {
    console.log(`❓ Querying document ${documentId}: "${question}"`);
    
    // ✅ FIX: Try to find document by ID first, then by fileName
    let documentContent = documentStore.get(documentId);
    
    if (!documentContent) {
      // Maybe documentId is actually a fileName, try the mapping
      const actualDocId = documentFileNameMap.get(documentId);
      if (actualDocId) {
        console.log(`🔄 Found documentId via fileName mapping: ${documentId} -> ${actualDocId}`);
        documentContent = documentStore.get(actualDocId);
      }
    }

    if (!documentContent) {
      console.log(`❌ Document not found. Available documents:`, Array.from(documentStore.keys()));
      console.log(`📋 Available fileName mappings:`, Array.from(documentFileNameMap.entries()));
      return `❌ **No document found**. Please upload a document first using the upload button.`;
    }

    // Truncate document if too long (Groq has token limits)
    const maxChars = 25000; // Adjust based on your model's context window
    const truncatedContent = documentContent.length > maxChars 
      ? documentContent.slice(0, maxChars) + '\n\n[... document truncated ...]'
      : documentContent;

    return {
      content: truncatedContent,
      question: question
    };
  } catch (error: any) {
    console.error('Document query error:', error);
    return `⚠️ **Error querying document:** ${error.message}`;
  }
}

export const runtime = 'nodejs';

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY! });

const db = mysql.createPool({
  host: 'localhost',
  user: 'root',
  password: 'root',
  database: 'collegedb',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0
});

async function get_attendance({ roll_number }: any) {
  console.log("parameters to get attendance is : " + roll_number)
  try {
    const [rows]: any = await db.execute("SELECT attendance_percentage FROM students WHERE id = ?", [roll_number]);
    if (rows.length > 0) {
      return `Your attendance is ${rows[0].attendance_percentage}%.`;
    } else {
      return "Roll number not found. Please check and try again.";
    }
  } catch (error) {
    console.error("Error fetching attendance:", error);
    return "Error retrieving attendance. Please try again later.";
  }
}

// Function to fetch timetable by year and department
async function get_timetable({ year, branch }: any) {

  console.log("parameters to get timetable are : " + year + "  " + branch)
  try {
    const [rows]: any = await db.execute(
      "SELECT day, time_slot, subject FROM timetable WHERE year = ? AND branch = ? ORDER BY FIELD(day, 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'), time_slot",
      [year, branch]
    );

    if (rows.length > 0) {
      let timetableText = `Here is the timetable for ${year} year, ${branch} branch:\n\n`;
      let currentDay = "";

      rows.forEach(({ day, time_slot, subject }: any) => {
        if (day !== currentDay) {
          timetableText += `📅 ${day}:\n`;
          currentDay = day;
        }
        timetableText += `  ⏰ ${time_slot} - ${subject}\n`;
      });

      return timetableText;
    } else {
      return "Timetable not found for the given year and branch.";
    }
  } catch (error) {
    console.error("Error fetching timetable:", error);
    return "Error retrieving timetable. Please try again later.";
  }
}

const tools = [
  {
    type: "function" as const,
    function: {
      name: "get_attendance",
      description: "Fetch student attendance based on roll number.",
      parameters: {
        type: "object",
        properties: {
          roll_number: {
            type: "string",
            description: "The student's roll number."
          }
        },
        required: ["roll_number"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_timetable",
      description: "Fetch the class timetable based on year and branch.",
      parameters: {
        type: "object",
        properties: {
          year: {
            type: "integer",
            description: "The academic year (e.g., 1,2,3)."
          },
          branch: {
            type: "string",
            description: "The branch name (e.g., CSE,MECH,CIVIL)."
          }
        },
        required: ["year", "branch"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "get_syllabus_from_pdf",
      description: "Extract unit-wise syllabus from a given subject in the syllabus PDF.",
      parameters: {
        type: "object",
        properties: {
          subject: {
            type: "string",
            description: "The subject name, e.g., 'Compiler Design'"
          },
          unit: {
            type: "string",
            description: "The unit number, e.g., '1', '2', etc."
          }
        },
        required: ["subject", "unit"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "upload_document",
      description: "Upload and store a document (PDF, TXT, MD) for later querying.",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description: "Unique identifier for the document"
          },
          fileName: {
            type: "string",
            description: "Name of the uploaded file"
          },
          fileContent: {
            type: "string",
            description: "Base64 encoded file content"
          },
          fileType: {
            type: "string",
            description: "MIME type of the file (e.g., 'application/pdf', 'text/plain')"
          }
        },
        required: ["documentId", "fileName", "fileContent", "fileType"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "query_document",
      description: "Answer questions about a previously uploaded document. Use the documentId OR fileName from the most recent upload.",
      parameters: {
        type: "object",
        properties: {
          documentId: {
            type: "string",
            description: "The ID or fileName of the uploaded document to query"
          },
          question: {
            type: "string",
            description: "The question to answer from the document"
          }
        },
        required: ["documentId", "question"]
      }
    }
  }
];
const systemMessage = {
  role: "system",
  content: `You are DYPCET AI Assistant, a helpful, polite, and knowledgeable virtual assistant for Dr. D. Y. Patil College of Engineering & Technology (DYPCET).
    Your job is to assist students by providing accurate and relevant information about the college.
    You have access to certain tools to fetch student-specific data such as attendance and class timetable.
    If the users input has some spelling mistakes, please correct them and analyse the tool use required or not.

🧠 Personality & Behavior Guidelines

    Always be polite, respectful, and professional.

    Maintain a friendly and approachable tone, suitable for interacting with college students.

    If a user asks for personal data like attendance or timetable, guide them to provide the required info (e.g., roll number, department, year).

    If a tool call is needed, extract the required information clearly and use the appropriate tool.

    If the user input is unclear, ask clarifying questions before using any tool.

    Avoid making up answers—use tool results wherever applicable.

    If a question is unrelated to the college or your capabilities, politely decline to answer and guide the user accordingly.

    Do not share or assume private data unless explicitly provided by the user.

    ⚠️ Important: When requesting timetable, always convert year to integer (1,2,3,4) and branch to exact database name ("Computer Science", "Mechanical", "Civil", etc.) before calling get_timetable.

    ⚠️ Important Database Mapping:
- If user says "CSE" or "Computer Science", use branch: "CSE"
- If user says "Mech" or "Mechanical", use branch: "MECH"
- If user says "Civil", use branch: "CIVIL"
- Ensure the branch name is always Uppercase when calling the tool.

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
    - IMPORTANT: When answering questions about uploaded documents, ONLY use information from the uploaded document content, not from your general knowledge.

    Stay concise, but helpful.

    Try to strictly generate the response in proper markdown format so that it would render properly on frontend UI.
    You can decide the markdown style/design according to the scenario such as generating table, bold heading, etc.
    Try to make the chat interactive with adding some emojis and icons as you want.

🛠️ Available Tools

You have access to the following tools:

    get_attendance
    Use this to fetch a student's attendance by roll number.
    Required: roll_number (string)

    get_timetable
    Use this to fetch the class timetable based on the academic year and department.
    Required: year (int) and branch (string)
    example format: year:1 branch:CSE 

    upload_document
    Use this to store uploaded documents for querying.
    Required: documentId, fileName, fileContent (base64), fileType

    query_document
    Use this to answer questions about uploaded documents.
    Required: documentId (can be the actual ID or the fileName), question
    
    get_syllabus_from_pdf
    Use this to extract unit-wise syllabus.
    Required: subject (string), unit (string)
`,
};

const availableFunctions: Record<string, Function> = {
  get_attendance,
  get_timetable,
  get_syllabus_from_pdf,
  upload_document,
  query_document,
};


export async function POST(req: Request) {
  const { messages, documentUpload } = await req.json();
  
  // Handle document upload separately
  if (documentUpload) {
    const { documentId, fileName, fileContent, fileType } = documentUpload;
    const result = await upload_document({ documentId, fileName, fileContent, fileType });
    return new Response(
      JSON.stringify({
        message: {
          role: "assistant",
          content: result,
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  }

  const userMessage = messages[messages.length - 1].content;
  console.log("\nUser input:", userMessage, "\n");

  const updatedMessages = [systemMessage, ...messages];

  // Call the main LLM to decide tool usage
  const response = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    messages: updatedMessages,
    tools: tools,
    tool_choice: "auto",
    max_tokens: 4096,
  });

  const responseMessage = response.choices[0].message;
  const toolCalls = responseMessage.tool_calls;

  if (responseMessage.content != undefined) {
    console.log("First LLM Call Response:", responseMessage.content);
  } else {
    console.log("LLM decided to use tools.");
  }

  // Handle tool calls
  if (toolCalls && toolCalls.length > 0) {
    updatedMessages.push(responseMessage);
    for (const toolCall of toolCalls) {
      const functionName = toolCall.function.name;
      const func = availableFunctions[functionName];
      if (!func) continue;

      const functionArgs = JSON.parse(toolCall.function.arguments);
      const functionResponse = await func(functionArgs);
      console.log(`Tool ${functionName} response:`, functionResponse);

      // ✅ 1. DOCUMENT QUERY: Keep existing logic exactly as is
      if (functionName === "query_document") {
        if (typeof functionResponse === 'object' && functionResponse.content) {
          updatedMessages.push({
            role: "user",
            content: `Based ONLY on the following document content, please answer this question: "${functionResponse.question}"\n\nDocument Content:\n${functionResponse.content}\n\nIMPORTANT: Only use information from the document content above. Do not use your general knowledge.`,
          });

          const docQueryResponse = await groq.chat.completions.create({
            model: "llama-3.3-70b-versatile",
            messages: updatedMessages,
            max_tokens: 4096,
          });

          return new Response(
            JSON.stringify({
              message: {
                role: "assistant",
                content: docQueryResponse.choices[0].message.content,
                tool_used: functionName,
              },
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        } else {
          return new Response(
            JSON.stringify({
              message: {
                role: "assistant",
                content: functionResponse, // Error message
                tool_used: functionName,
              },
            }),
            { headers: { "Content-Type": "application/json" } }
          );
        }
      }

      // ✅ 2. SYLLABUS & OTHERS: Append result to history (removed early return)
      updatedMessages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        name: functionName,
        content: typeof functionResponse === 'string' ? functionResponse : JSON.stringify(functionResponse),
      });

      // ✅ 3. NEW: Add "Interactive Study Tips" instruction ONLY for syllabus
      if (functionName === "get_syllabus_from_pdf") {
        updatedMessages.push({
          role: "system",
          content: `The syllabus content is provided above. 
          Now, present this to the student in a highly engaging Markdown format.
          1. List the topics clearly with relevant emojis.
          2. Add a '🧠 Smart Study Strategy' section: Explain which topics might be conceptually hard or high-scoring based on the content.
          3. Add a '❓ Practice Question' idea based on the topics.
          4. Add a '🔄 Revision Tip' to help the student remember the content effectively.
          5. Keep the tone encouraging.`
        });
      }
    }

    // Second LLM call to incorporate tool results
    const secondResponse = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: updatedMessages,
    });

    return new Response(
      JSON.stringify({
        message: {
          ...secondResponse.choices[0].message,
          role: "assistant",
          tool_used: toolCalls[0].function.name,
        },
      }),
      { headers: { "Content-Type": "application/json" } }
    );
  } else {
    // No tool needed
    return new Response(
      JSON.stringify({ message: responseMessage }),
      { headers: { "Content-Type": "application/json" } }
    );
  }
}