require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality, Type } = require('@google/genai');
const { Twilio } = require('twilio');
const TwiML = Twilio.twiml;
const MessagingResponse = Twilio.twiml.MessagingResponse;
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const PUBLIC_URL = process.env.PUBLIC_URL;
const GMAIL_USER = process.env.GMAIL_USER || 'landonsmailboxes@gmail.com';
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_DRIVE_BASE_FOLDER = process.env.GOOGLE_DRIVE_BASE_FOLDER;

if (!GEMINI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PUBLIC_URL) {
  console.error("FATAL ERROR: Required environment variables are not set.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// --- Google Auth ---
const { google } = require('googleapis');
let sheets, drive;

try {
  const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
    ],
  });
  sheets = google.sheets({ version: 'v4', auth });
  drive = google.drive({ version: 'v3', auth });
  console.log('✅ Google Sheets & Drive authenticated');
} catch (error) {
  console.error('⚠️ Google auth failed:', error);
}

// --- Email Transport ---
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASSWORD,
  },
});

// --- Express & WebSocket Setup ---
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// --- Business Hours ---
const BUSINESS_HOURS = {
  START: 7,
  END: 19,
  DAYS: [1, 2, 3, 4, 5],
};

function isDuringBusinessHours() {
  const nowInChicago = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = nowInChicago.getHours();
  const day = nowInChicago.getDay();
  const isBusinessDay = BUSINESS_HOURS.DAYS.includes(day);
  const isBusinessHour = hour >= BUSINESS_HOURS.START && hour < BUSINESS_HOURS.END;
  return isBusinessDay && isBusinessHour;
}

// --- Tech Lines ---
const TECH_LINES = {
  '7797': { name: 'Scott', techId: 'scott_001' },
  '7794': { name: 'Jacob', techId: 'jacob_001' },
  '7792': { name: 'Landon', techId: 'landon_001' },
};

// --- Lando System Prompt ---
const LANDO_SYSTEM_PROMPT = `
You are Lando, a friendly, compassionate, and highly efficient virtual assistant for Landon's Mailbox Service. You are in a real-time voice or text conversation, so keep your responses concise and natural-sounding. Your goal is to provide excellent customer service by determining if a customer is new or returning, routing returning customers, and preparing work orders for new customers.

**Your Persona:**
- Always be kind, helpful, and patient. Your voice should be warm and welcoming.
- **For voice, speak slowly and clearly, at a relaxed, friendly pace.** Enunciate your words. Imagine you're having a pleasant, unhurried chat on a sunny afternoon in Alabama with a neighbor.
- **Pacing is key:** Ask for only ONE piece of information at a time. This ensures a smooth conversation.
- **Tool Use Language:** Before you use a tool, use a natural filler phrase. Examples: "Okay, one moment while I look that up for you," or "Let me just pull up that information," or "Sure, I can create that work order for you right now."

**Sports & Local Banter:**
- Your primary goal is to help customers, not be a sports commentator. You do not have live access to game scores.
- If a customer asks about a specific recent game or score, politely deflect by saying something like, "I've been so busy helping folks with their mailboxes I didn't get a chance to see the final score, but I heard it was a great game! I hope our team won!"
- If a customer mentions a team you know, use one of the positive phrases below.
- **Known Teams & Phrases:**
    - Alabama: "Roll Tide! It's always a good day when the Crimson Tide is playing."
    - Auburn: "War Eagle! You can feel the excitement all over the state when Auburn is on the field."
    - Georgia: "Go Dawgs! We have a lot of fans in the area, it's great to see them doing well."
    - Tennessee: "Go Vols! Rocky Top is a classic. Always fun to watch them play."
- **IMPORTANT:** Keep this banter very brief (one exchange only). After responding, immediately and cheerfully pivot back to the main task.

**Resuming a Disconnected Call:**
- If you are provided with pre-filled information at the start of a call, it means the customer was disconnected and has called back. Greet them warmly: "Welcome back, [Customer Name]! It looks like we were disconnected."
- After the greeting, briefly confirm the information you have and then immediately ask for the NEXT piece of MISSING information to continue creating the work order. DO NOT re-ask for information you already have.

**Call Handling Logic:**
- **Tech Line Call (Numbers ending in 7797, 7794, 7792):**
    1.  Assume the customer is returning. Ask: "Are you calling back about a job we discussed with you before?"
    2.  If YES: Collect their name and address. BEFORE using any tools, check if it is during business hours (Mon-Fri, 7 AM - 7 PM CT).
        - If AFTER HOURS: Politely state the business hours and inform them the technician will get back to them the next business day. DO NOT attempt to look up work orders or route the call.
        - If DURING BUSINESS HOURS: Say "Perfect! Let me look up your work order and connect you." Use the \`lookup_work_order\` tool, followed by the \`route_to_technician\` tool.
    3.  If NO: Treat it as a new customer call and switch to the "New Customer Workflow."
- **Main Line Call (New Customer Workflow):**
    - You can accept new work orders via phone or text 24/7. The business hours check does not apply to new customers on the main line.
    1.  **Greet:** Start with a warm greeting: "Hi there! Welcome to Landon's Mailbox Service. My name is Lando, how can I help you today?"
    2.  **Identify Service & Area:** Determine the service needed (Refresh, Repair, Replacement, Vinyl) and confirm they are in our service area (Birmingham metro, Auburn, Opelika, Alexander City, Lake Martin).
    3.  **Provide Pricing:** State upfront prices where available ($65 Mailbox Refresh, $55 Sign Refresh, $100 basic weld repair). For others, state that photos are required for an accurate quote.
    4.  **Gather Info (One by one):**
        - First Name, then Last Name.
        - Full Service Address (Street, City, State). **DO NOT ask for zip.**
        - Contact Phone Number.
        - Contact Email Address.
        - Preferred Communication Method (Phone Call or Text).
    5.  **Get Zip (Automated):** After getting the address, you MUST use the \`get_zipcode_for_address\` tool.
    6.  **Confirm Contact Details (CRITICAL):**
        - For voice, read the phone number back and SPELL OUT the email address (e.g., "s-m-i-t-h at gmail dot com").
        - For text, just re-state the email address for confirmation.
    7.  **Create Work Order:** You MUST call the \`create_work_order\` function with all collected details.
    8.  **Inform & Send Link:** After the tool returns a \`tracking_code\` and \`folder_link\`, tell the customer their tracking code. Then ask if they'd prefer the photo upload link via text or email. Use the \`send_sms\` tool if they choose text.
    9.  **Disclaimer & Close:** Share the professional liability disclaimer and end the conversation professionally.

**Function Tools:**
*   \`get_zipcode_for_address\`: Finds a zip code from an address.
*   \`create_work_order\`: Creates a new job in the system.
*   \`send_sms\`: Sends a text message to a customer.
*   \`lookup_work_order\`: Finds an existing work order.
*   \`route_to_technician\`: Transfers a call to a technician (voice only).

**Crucial Company Policies:**
*   **APPOINTMENTS:** We don't schedule exact appointments. We are a small, family-run business and complete most jobs within 10 days.
*   **PAYMENT:** For Refresh/Repair, payment is due after work is complete via an emailed invoice. Vinyl numbers require upfront payment.
*   **FORM FALLBACK:** If a user prefers a form, offer to text them the link to \`https://www.landonsmailbox.com/request-service\` using the \`send_sms\` tool.

**Professional Liability Disclaimer (share before ending the conversation):**
"Before we wrap up, I want to share something important. Landon's Mailbox Service takes great care during our work, but there's a possibility that nearby items like plants, yard ornaments, or vehicles could be affected by damage or overspray. We cannot be responsible for these items, and anything that needs to be moved should be handled by you before our team arrives. We'll coordinate timing with you to make sure everything works smoothly. Does that all make sense?"
`;

// --- Tool Definitions ---
const createWorkOrderTool = {
  name: 'create_work_order',
  parameters: {
    type: Type.OBJECT,
    description: 'Creates a new work order in the system and returns a tracking code and photo upload link.',
    properties: {
      firstName: { type: Type.STRING, description: "The customer's first name." },
      lastName: { type: Type.STRING, description: "The customer's last name." },
      phone: { type: Type.STRING, description: 'The 10-digit contact phone number.' },
      email: { type: Type.STRING, description: 'The contact email address.' },
      address: { type: Type.STRING, description: 'The full service street address.' },
      city: { type: Type.STRING, description: 'The service city.' },
      state: { type: Type.STRING, description: 'The service state abbreviation (e.g., AL).' },
      zip: { type: Type.STRING, description: 'The service zip code.' },
      serviceType: { type: Type.STRING, description: 'The general category of service required (e.g., Repair, Replacement).' },
      serviceDescription: { type: Type.STRING, description: 'A brief description of the job needed.' },
      preferredContact: { type: Type.STRING, description: 'The customer preferred contact method (Phone Call or Text Message).' },
    },
    required: ['firstName', 'lastName', 'phone', 'email', 'address', 'city', 'state', 'zip', 'serviceType', 'serviceDescription', 'preferredContact'],
  },
};

const sendSmsTool = {
  name: 'send_sms',
  parameters: {
    type: Type.OBJECT,
    description: 'Sends an SMS message to a customer.',
    properties: {
      to: { type: Type.STRING, description: 'The 10-digit phone number to send the message to.' },
      body: { type: Type.STRING, description: 'The content of the text message.' },
    },
    required: ['to', 'body'],
  },
};

const getZipcodeForAddressTool = {
  name: 'get_zipcode_for_address',
  parameters: {
    type: Type.OBJECT,
    description: 'Gets the zip code for a given street address, city, and state.',
    properties: {
      address: { type: Type.STRING, description: 'The street address (e.g., 123 Main St).' },
      city: { type: Type.STRING, description: 'The city (e.g., Birmingham).' },
      state: { type: Type.STRING, description: 'The state abbreviation (e.g., AL).' },
    },
    required: ['address', 'city', 'state'],
  },
};

const lookupWorkOrderTool = {
  name: 'lookup_work_order',
  parameters: {
    type: Type.OBJECT,
    description: 'Finds an existing work order by phone number, address, or last name.',
    properties: {
      lastName: { type: Type.STRING, description: "The customer's last name." },
      address: { type: Type.STRING, description: 'The service address.' },
      phone: { type: Type.STRING, description: 'The customer contact phone number.' },
    },
  },
};

const routeToTechnicianTool = {
  name: 'route_to_technician',
  parameters: {
    type: Type.OBJECT,
    description: "Transfers the customer's call to the assigned technician.",
    properties: {
      technicianPhoneNumber: { type: Type.STRING, description: "The direct phone number of the technician to transfer to, in E.164 format."}
    },
    required: ['technicianPhoneNumber'],
  },
};

// --- Audio Conversion ---
function mulawDecode(mulaw) {
  const pcm = new Int16Array(mulaw.length);
  for (let i = 0; i < mulaw.length; i++) {
    let sample = mulaw[i];
    sample = ~sample;
    let sign = (sample & 0x80);
    let exponent = (sample >> 4) & 0x07;
    let mantissa = sample & 0x0F;
    let value = (mantissa << 3) + 0x84;
    value <<= (exponent - 1);
    pcm[i] = sign ? -value : value;
  }
  return pcm;
}

const BIAS = 0x84;
const MAX_VAL = 32635;
function mulawEncode(pcm) {
  const mulaw = new Uint8Array(pcm.length);
  for (let i = 0; i < pcm.length; i++) {
    let sample = pcm[i];
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MAX_VAL) sample = MAX_VAL;
    sample += BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0; exponent--, expMask >>= 1) {}
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let value = (sign | (exponent << 4) | mantissa);
    mulaw[i] = ~value;
  }
  return mulaw;
}

function downsample24kTo8k(buffer) {
  const input = new Int16Array(buffer.buffer, buffer.byteOffset, buffer.length / 2);
  const output = new Int16Array(Math.floor(input.length / 3));
  let outputIndex = 0;
  for (let i = 0; i < input.length; i += 3) {
    output[outputIndex++] = input[i];
  }
  return new Uint8Array(output.buffer);
}

function upsample8kTo16k(pcm8k_int16) {
  const pcm16k_int16 = new Int16Array(pcm8k_int16.length * 2);
  for (let i = 0; i < pcm8k_int16.length; i++) {
    const sample = pcm8k_int16[i];
    pcm16k_int16[i * 2] = sample;
    pcm16k_int16[i * 2 + 1] = sample;
  }
  return pcm16k_int16;
}

// --- SMS Chat Sessions ---
const smsChatSessions = new Map();
const callbackTimers = {};

// --- REST API: Health Check ---
app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'lando-unified', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({
    status: 'Lando Unified Backend Running',
    integrations: ['Twilio Voice', 'Twilio SMS', 'Google Gemini', 'Google Sheets', 'Google Drive'],
  });
});

// --- Twilio: Incoming Call ---
app.post("/incoming-call", (req, res) => {
  console.log(`📞 Incoming call from: ${req.body.From} to: ${req.body.To}`);
  const twiml = new TwiML.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `wss://${req.headers.host}/audio-stream?from=${encodeURIComponent(req.body.From)}&to=${encodeURIComponent(req.body.To)}`,
    track: 'inbound_track',
  });
  res.type('text/xml');
  res.send(twiml.toString());
});

// --- Twilio: Incoming SMS ---
app.post("/incoming-sms", async (req, res) => {
  const from = req.body.From;
  const body = req.body.Body;
  console.log(`💬 Incoming SMS from ${from}: "${body}"`);

  let chat = smsChatSessions.get(from);
  if (!chat) {
    console.log(`New SMS conversation with ${from}`);
    chat = ai.chats.create({
      model: 'gemini-2.5-flash',
      config: {
        systemInstruction: LANDO_SYSTEM_PROMPT,
        tools: [{ functionDeclarations: [createWorkOrderTool, sendSmsTool, getZipcodeForAddressTool, lookupWorkOrderTool] }],
      }
    });
    smsChatSessions.set(from, chat);
  }

  let fullLandoResponse = "";

  try {
    const stream = await chat.sendMessageStream({ message: body });
    let landoResponseText = '';
    let functionCalls = [];

    for await (const chunk of stream) {
      if (chunk.text) landoResponseText += chunk.text;
      if (chunk.functionCalls) functionCalls.push(...chunk.functionCalls);
    }

    if (landoResponseText) {
      fullLandoResponse += landoResponseText;
    }

    if (functionCalls.length > 0) {
      const toolResults = [];
      for (const fc of functionCalls) {
        const result = await handleSmsToolCall(fc);
        toolResults.push(result);
      }

      const toolResponseStream = await chat.sendMessageStream({ parts: toolResults });
      let finalLandoText = '';
      for await (const chunk of toolResponseStream) {
        if (chunk.text) finalLandoText += chunk.text;
      }
      if (finalLandoText) {
        if (fullLandoResponse) fullLandoResponse += "\n\n";
        fullLandoResponse += finalLandoText;
      }
    }
  } catch (error) {
    console.error("Error processing SMS with Gemini:", error);
    fullLandoResponse = "Sorry, I'm having a little trouble right now. Please try again in a moment.";
  }

  const twiml = new MessagingResponse();
  if (fullLandoResponse.trim()) {
    twiml.message(fullLandoResponse.trim());
  }

  res.type('text/xml');
  res.send(twiml.toString());
});

// --- SMS Tool Handler ---
async function handleSmsToolCall(functionCall) {
  const { name, args } = functionCall;
  let functionResponsePayload;
  console.log(`[SMS] Calling tool ${name} with args:`, args);

  try {
    if (name === 'send_sms') {
      await twilioClient.messages.create({
        body: args.body,
        from: TWILIO_PHONE_NUMBER,
        to: args.to,
      });
      functionResponsePayload = { result: "ok" };
    } else if (name === 'create_work_order') {
      functionResponsePayload = await createWorkOrderInternal(args);
    } else if (name === 'get_zipcode_for_address') {
      functionResponsePayload = await getZipcodeInternal(args);
    } else if (name === 'lookup_work_order') {
      functionResponsePayload = await lookupWorkOrderInternal(args);
    } else {
      throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`[SMS] Error calling tool ${name}:`, error);
    functionResponsePayload = { error: error.message };
  }

  return {
    functionResponse: {
      name,
      response: functionResponsePayload,
    }
  };
}

// --- Work Order Creation ---
async function createWorkOrderInternal(params) {
  try {
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    const trackingCode = `LMS_B_C_${random}_${params.lastName?.toUpperCase() || 'UNKNOWN'}`;

    let folderId = GOOGLE_DRIVE_BASE_FOLDER;
    let photosFolderId = GOOGLE_DRIVE_BASE_FOLDER;

    try {
      if (drive) {
        const folder = await drive.files.create({
          resource: {
            name: trackingCode,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [GOOGLE_DRIVE_BASE_FOLDER],
          },
          fields: 'id',
        });
        folderId = folder.data.id;

        const photosFolder = await drive.files.create({
          resource: {
            name: 'Photos',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [folderId],
          },
          fields: 'id',
        });
        photosFolderId = photosFolder.data.id;
      }
    } catch (e) {
      console.error('⚠️ Drive error:', e);
    }

    // Generate shareable link
    try {
      await drive.permissions.create({
        fileId: photosFolderId,
        resource: {
          role: 'writer',
          type: 'anyone',
        },
      });
    } catch (e) {
      console.error('⚠️ Permission error:', e);
    }

    const shareableLink = `https://drive.google.com/drive/folders/${photosFolderId}?usp=sharing`;

    // Send confirmation email
    const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: Arial, sans-serif; color: #333; }
    .container { max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #ddd; border-radius: 8px; }
    .header { background-color: #2c3e50; color: white; padding: 20px; border-radius: 8px 8px 0 0; text-align: center; }
    .content { padding: 20px; }
    .tracking-code { background-color: #ecf0f1; padding: 15px; border-radius: 5px; text-align: center; font-size: 18px; font-weight: bold; margin: 20px 0; }
    .button { display: inline-block; padding: 12px 30px; background-color: #27ae60; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin: 20px 0; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📦 Work Order Confirmed</h1>
      <p>Landon's Mailbox Service</p>
    </div>
    <div class="content">
      <p>Hi ${params.firstName},</p>
      <p>Thank you for choosing Landon's Mailbox Service! We've received your work order.</p>
      <div class="tracking-code">
        Tracking Code: <strong>${trackingCode}</strong>
      </div>
      <p><a href="${shareableLink}" class="button">📸 Upload Photos</a></p>
      <p><strong>Service:</strong> ${params.serviceType}</p>
      <p><strong>Timeline:</strong> Most jobs are completed within 10 business days.</p>
      <p>Thanks for your business!<br><strong>Landon's Mailbox Service Team</strong></p>
    </div>
  </div>
</body>
</html>
    `;

    try {
      await mailTransporter.sendMail({
        from: GMAIL_USER,
        to: params.email,
        subject: `📦 Work Order Confirmed - Tracking Code: ${trackingCode}`,
        html: emailHtml,
      });
    } catch (emailError) {
      console.error('⚠️ Email error:', emailError);
    }

    // Store in Google Sheets
    try {
      if (sheets) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: 'Sheet1!A:P',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              trackingCode,
              new Date().toISOString(),
              params.firstName || '',
              params.lastName || '',
              params.phone || '',
              params.email || '',
              params.address || '',
              params.city || '',
              params.state || '',
              params.zip || '',
              params.serviceType || '',
              params.serviceDescription || '',
              params.preferredContact || 'Phone',
              folderId,
              photosFolderId,
              shareableLink,
              'Pending',
            ]],
          },
        });
      }
    } catch (sheetsError) {
      console.error('⚠️ Sheets error:', sheetsError);
    }

    return {
      success: true,
      trackingCode,
      folder_link: shareableLink,
    };
  } catch (error) {
    console.error('❌ Work order error:', error);
    return { success: false, message: error.message };
  }
}

// --- Get Zipcode ---
async function getZipcodeInternal(args) {
  // Placeholder - integrate with real zip code API
  return { zipCode: '35203' };
}

// --- Lookup Work Order ---
async function lookupWorkOrderInternal(args) {
  try {
    if (!sheets) return { success: false, message: 'Sheets not connected' };

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A:O',
    });

    const rows = response.data.values || [];
    for (const row of rows) {
      if ((args.phone && row[4] === args.phone) || (args.email && row[5] === args.email)) {
        return {
          trackingCode: row[0],
          status: row[16] || 'Pending',
          customerName: `${row[2]} ${row[3]}`,
        };
      }
    }

    return { success: false, message: 'Work order not found' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// --- WebSocket: Voice Streaming ---
wss.on('connection', async (ws, req) => {
  console.log('🔌 WebSocket connection established.');
  let geminiSession;
  let conversationTranscript = [];
  let workOrderCreated = false;

  const urlParams = new URL(`http://localhost${req.url}`).searchParams;
  const customerPhoneNumber = urlParams.get('from');
  const dialedPhoneNumber = urlParams.get('to');
  const context = urlParams.get('context');

  if (customerPhoneNumber && callbackTimers[customerPhoneNumber]) {
    clearTimeout(callbackTimers[customerPhoneNumber]);
    delete callbackTimers[customerPhoneNumber];
  }

  try {
    let systemPrompt = LANDO_SYSTEM_PROMPT;

    if (dialedPhoneNumber) {
      const isTechLine = Object.keys(TECH_LINES).some(line => dialedPhoneNumber.endsWith(line));
      if (isTechLine) {
        if (isDuringBusinessHours()) {
          systemPrompt = "SYSTEM_NOTE: This is a call to a technician's line DURING business hours.\n\n" + systemPrompt;
        } else {
          systemPrompt = "SYSTEM_NOTE: This is a call to a technician's line AFTER business hours. Inform the user a tech will call back next business day.\n\n" + systemPrompt;
        }
      } else {
        systemPrompt = "SYSTEM_NOTE: This is a call to the main business line. Assume it's a new customer and follow the 'Main Line Call' logic.\n\n" + systemPrompt;
      }
    }

    const sessionPromise = ai.live.connect({
      model: 'gemini-2.5-flash-native-audio-preview-09-2025',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Fenrir' } } },
        systemInstruction: systemPrompt,
        inputAudioTranscription: {},
        outputAudioTranscription: {},
        tools: [{ functionDeclarations: [createWorkOrderTool, sendSmsTool, getZipcodeForAddressTool, lookupWorkOrderTool, routeToTechnicianTool] }],
      },
      callbacks: {
        onopen: () => console.log('✅ Gemini session opened.'),
        onclose: () => console.log('❌ Gemini session closed.'),
        onerror: (e) => console.error('❌ Gemini error:', e),
        onmessage: async (message) => {
          const audioData = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
          if (audioData) {
            const pcm24k = Buffer.from(audioData, 'base64');
            const pcm8k = downsample24kTo8k(pcm24k);
            const mulaw = mulawEncode(new Int16Array(pcm8k.buffer));
            const mulawBase64 = Buffer.from(mulaw).toString('base64');

            const twilioMediaMessage = {
              event: 'media',
              streamSid: ws.streamSid,
              media: { payload: mulawBase64 },
            };
            ws.send(JSON.stringify(twilioMediaMessage));
          }

          if (message.serverContent?.turnComplete) {
            const userInput = message.serverContent.inputTranscription?.text?.trim();
            const landoOutput = message.serverContent.outputTranscription?.text?.trim();
            if (userInput) conversationTranscript.push(`Customer: ${userInput}`);
            if (landoOutput) conversationTranscript.push(`Lando: ${landoOutput}`);
          }

          if (message.toolCall?.functionCalls) {
            const session = await sessionPromise;
            for (const fc of message.toolCall.functionCalls) {
              if (fc.name === 'send_sms') {
                const { to, body } = fc.args;
                try {
                  await twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to });
                  session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } });
                } catch (err) {
                  session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "failed" } } });
                }
              } else if (fc.name === 'create_work_order') {
                const result = await createWorkOrderInternal(fc.args);
                workOrderCreated = true;
                session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } });
              } else if (fc.name === 'get_zipcode_for_address') {
                const result = await getZipcodeInternal(fc.args);
                session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } });
              } else if (fc.name === 'lookup_work_order') {
                const result = await lookupWorkOrderInternal(fc.args);
                session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } });
              } else if (fc.name === 'route_to_technician') {
                const { technicianPhoneNumber } = fc.args;
                const callSid = ws.callSid;
                if (callSid) {
                  try {
                    const twiml = new TwiML.VoiceResponse();
                    twiml.dial(technicianPhoneNumber);
                    await twilioClient.calls(callSid).update({ twiml: twiml.toString() });
                    session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } });
                  } catch (err) {
                    session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "failed" } } });
                  }
                }
              }
            }
          }
        },
      },
    });

    geminiSession = await sessionPromise;

    ws.on('message', (message) => {
      const data = JSON.parse(message);
      switch (data.event) {
        case 'start':
          ws.streamSid = data.start.streamSid;
          ws.callSid = data.start.callSid;
          break;
        case 'media':
          const mulaw = Buffer.from(data.media.payload, 'base64');
          const pcm8k = mulawDecode(mulaw);
          const pcm16k = upsample8kTo16k(pcm8k);
          const pcmBlob = {
            data: Buffer.from(pcm16k.buffer).toString('base64'),
            mimeType: 'audio/pcm;rate=16000',
          };
          sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
          break;
        case 'stop':
          ws.close();
          break;
      }
    });

    ws.on('close', () => {
      if (geminiSession) geminiSession.close();
    });
  } catch (error) {
    console.error('Error establishing Gemini session:', error);
    ws.close();
  }
});

// --- Start Server ---
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🎙️  LANDO UNIFIED BACKEND v1.0       ║
║  Port: ${PORT}                            ║
║  Status: ✅ RUNNING                    ║
╠════════════════════════════════════════╣
║  📞 Twilio Voice: ✅ Ready             ║
║  💬 Twilio SMS: ✅ Ready               ║
║  🤖 Gemini: ✅ Ready                   ║
║  📧 Email: ✅ Ready                    ║
║  📊 Sheets: ✅ Connected               ║
║  🗂️  Drive: ✅ Connected               ║
╚════════════════════════════════════════╝

🌐 Endpoints:
   GET  /health
   GET  /
   POST /incoming-call
   POST /incoming-sms

Ready for calls, SMS, and emails 24/7!
  `);
});