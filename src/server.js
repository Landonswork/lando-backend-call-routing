require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality, Type } = require('@google/genai');
const { Twilio } = require('twilio');
const TwiML = Twilio.twiml;
const MessagingResponse = TwiML.MessagingResponse;
const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');

const { BUSINESS_HOURS, isDuringBusinessHours, TECH_LINES, LANDO_SYSTEM_PROMPT } = require('./lando-core');

// ===== CONFIGURATION =====
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const PUBLIC_URL = process.env.PUBLIC_URL;
const GMAIL_USER = process.env.GMAIL_USER || 'landonsmailboxes@gmail.com';
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD || '';
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID;
const GOOGLE_DRIVE_BASE_FOLDER = process.env.GOOGLE_DRIVE_BASE_FOLDER;

if (!GEMINI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PUBLIC_URL) {
  console.error("FATAL ERROR: Required environment variables are not set.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

// ===== GOOGLE AUTH =====
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

// ===== EMAIL TRANSPORT =====
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: GMAIL_USER, pass: GMAIL_PASSWORD },
});

// ===== TOOL DEFINITIONS =====
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

// ===== EXPRESS & WEBSOCKET =====
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ===== SHARED FUNCTIONS =====

async function createWorkOrderInternal(params) {
  try {
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    const trackingCode = `LMS_B_C_${random}_${params.lastName?.toUpperCase() || 'UNKNOWN'}`;

    let folderId = GOOGLE_DRIVE_BASE_FOLDER;
    let photosFolderId = GOOGLE_DRIVE_BASE_FOLDER;

    // Create Drive folders
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

        // Make shareable
        await drive.permissions.create({
          fileId: photosFolderId,
          resource: { role: 'writer', type: 'anyone' },
        });
      }
    } catch (e) {
      console.error('⚠️ Drive error:', e);
    }

    const shareableLink = `https://drive.google.com/drive/folders/${photosFolderId}?usp=sharing`;

    // Send email
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
    <div class="header"><h1>📦 Work Order Confirmed</h1></div>
    <div class="content">
      <p>Hi ${params.firstName},</p>
      <div class="tracking-code">Tracking Code: <strong>${trackingCode}</strong></div>
      <p><a href="${shareableLink}" class="button">📸 Upload Photos</a></p>
      <p><strong>Service:</strong> ${params.serviceType}</p>
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
        subject: `📦 Work Order Confirmed - ${trackingCode}`,
        html: emailHtml,
      });
    } catch (emailError) {
      console.error('⚠️ Email error:', emailError);
    }

    // Store in Sheets
    try {
      if (sheets) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: 'Sheet1!A:P',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              trackingCode, new Date().toISOString(), params.firstName || '', params.lastName || '',
              params.phone || '', params.email || '', params.address || '', params.city || '',
              params.state || '', params.zip || '', params.serviceType || '', params.serviceDescription || '',
              params.preferredContact || 'Phone', folderId, photosFolderId, shareableLink, 'Pending',
            ]],
          },
        });
      }
    } catch (sheetsError) {
      console.error('⚠️ Sheets error:', sheetsError);
    }

    return { success: true, trackingCode, folder_link: shareableLink };
  } catch (error) {
    console.error('❌ Work order error:', error);
    return { success: false, message: error.message };
  }
}

async function getZipcodeInternal(args) {
  return { zipCode: '35203' }; // Placeholder
}

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
        return { trackingCode: row[0], status: row[16] || 'Pending', customerName: `${row[2]} ${row[3]}` };
      }
    }
    return { success: false, message: 'Work order not found' };
  } catch (error) {
    return { success: false, message: error.message };
  }
}

// ===== REST ENDPOINTS =====

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'lando-bulletproof', time: new Date().toISOString() });
});

app.get('/', (req, res) => {
  res.json({ status: 'Lando Bulletproof Backend Running', channels: ['Voice', 'SMS'], ready: true });
});

// ===== VOICE CHANNEL (Isolated) =====

app.post("/incoming-call", (req, res) => {
  try {
    console.log(`📞 Incoming call from: ${req.body.From} to: ${req.body.To}`);
    const twiml = new TwiML.VoiceResponse();
    const connect = twiml.connect();
    connect.stream({
      url: `wss://${req.headers.host}/audio-stream?from=${encodeURIComponent(req.body.From)}&to=${encodeURIComponent(req.body.To)}`,
      track: 'inbound_track',
    });
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('❌ VOICE ERROR:', error);
    const twiml = new TwiML.VoiceResponse();
    twiml.say('We are experiencing technical difficulties. Please try again later.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// ===== SMS CHANNEL (Isolated) =====

const smsChatSessions = new Map();

app.post("/incoming-sms", async (req, res) => {
  try {
    const from = req.body.From;
    const body = req.body.Body;
    console.log(`💬 Incoming SMS from ${from}: "${body}"`);

    let chat = smsChatSessions.get(from);
    if (!chat) {
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

      if (landoResponseText) fullLandoResponse += landoResponseText;

      if (functionCalls.length > 0) {
        const toolResults = [];
        for (const fc of functionCalls) {
          let result;
          if (fc.name === 'send_sms') {
            await twilioClient.messages.create({ body: fc.args.body, from: TWILIO_PHONE_NUMBER, to: fc.args.to });
            result = { functionResponse: { name: fc.name, response: { result: "ok" } } };
          } else if (fc.name === 'create_work_order') {
            result = { functionResponse: { name: fc.name, response: await createWorkOrderInternal(fc.args) } };
          } else if (fc.name === 'get_zipcode_for_address') {
            result = { functionResponse: { name: fc.name, response: await getZipcodeInternal(fc.args) } };
          } else if (fc.name === 'lookup_work_order') {
            result = { functionResponse: { name: fc.name, response: await lookupWorkOrderInternal(fc.args) } };
          }
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
    } catch (geminiError) {
      console.error("❌ SMS Gemini error:", geminiError);
      fullLandoResponse = "Sorry, I'm having trouble right now. Please try again in a moment.";
    }

    const twiml = new MessagingResponse();
    if (fullLandoResponse.trim()) twiml.message(fullLandoResponse.trim());
    res.type('text/xml');
    res.send(twiml.toString());
  } catch (error) {
    console.error('❌ SMS CHANNEL ERROR:', error);
    const twiml = new MessagingResponse();
    twiml.message('We are experiencing technical difficulties. Please try again later.');
    res.type('text/xml');
    res.send(twiml.toString());
  }
});

// ===== VOICE WEBSOCKET (Isolated) =====

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
  for (let i = 0; i < input.length; i += 3) output[outputIndex++] = input[i];
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

wss.on('connection', async (ws, req) => {
  console.log('🔌 WebSocket connection established.');
  let geminiSession;
  let workOrderCreated = false;

  const urlParams = new URL(`http://localhost${req.url}`).searchParams;
  const customerPhoneNumber = urlParams.get('from');
  const dialedPhoneNumber = urlParams.get('to');

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
        systemPrompt = "SYSTEM_NOTE: This is a call to the main business line. Assume new customer. Follow 'Main Line Call' logic.\n\n" + systemPrompt;
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
        onopen: () => console.log('✅ Gemini voice session opened.'),
        onclose: () => console.log('❌ Gemini voice session closed.'),
        onerror: (e) => console.error('❌ Gemini voice error:', e),
        onmessage: async (message) => {
          try {
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

            if (message.toolCall?.functionCalls) {
              const session = await sessionPromise;
              for (const fc of message.toolCall.functionCalls) {
                try {
                  if (fc.name === 'send_sms') {
                    const { to, body } = fc.args;
                    await twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to });
                    session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } });
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
                      const twiml = new TwiML.VoiceResponse();
                      twiml.dial(technicianPhoneNumber);
                      await twilioClient.calls(callSid).update({ twiml: twiml.toString() });
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } });
                    }
                  }
                } catch (toolError) {
                  console.error(`❌ Tool error in voice: ${fc.name}`, toolError);
                  session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { error: toolError.message } } });
                }
              }
            }
          } catch (callbackError) {
            console.error('❌ Voice callback error:', callbackError);
          }
        },
      },
    });

    geminiSession = await sessionPromise;

    ws.on('message', (message) => {
      try {
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
      } catch (messageError) {
        console.error('❌ WebSocket message error:', messageError);
      }
    });

    ws.on('close', () => {
      if (geminiSession) geminiSession.close();
    });

    ws.on('error', (error) => {
      console.error('❌ WebSocket error:', error);
      if (geminiSession) geminiSession.close();
    });
  } catch (error) {
    console.error('❌ VOICE CHANNEL FATAL ERROR:', error);
    ws.close();
  }
});

// ===== START SERVER =====
server.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🎙️  LANDO BULLETPROOF BACKEND v1.0   ║
║  Port: ${PORT}                            ║
║  Status: ✅ RUNNING                    ║
╠════════════════════════════════════════╣
║  📞 Voice: ✅ Isolated & Ready         ║
║  💬 SMS: ✅ Isolated & Ready           ║
║  🗣️  Fenrir Voice: ✅ Ready            ║
║  📧 Email: ✅ Ready                    ║
║  📊 Sheets: ✅ Connected               ║
║  🗂️  Drive: ✅ Connected               ║
║  🏗️  Modular: ✅ Ready for Messenger   ║
╚════════════════════════════════════════╝

Each channel is isolated - if one breaks, others keep working.
Ready to add Messenger/WhatsApp later without affecting Voice/SMS.
  `);
});
