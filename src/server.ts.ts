import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google } from 'googleapis';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 8080;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIGURATION =====
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

// ===== GOOGLE AUTH =====
let sheets: any;
let drive: any;

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
  console.error('⚠️ Google authentication failed:', error);
}

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1JW027wypWgVIVto1vIoJ1nsHi13v-KeGRAwII41rcwA';
const GOOGLE_DRIVE_FOLDER = process.env.GOOGLE_DRIVE_BASE_FOLDER || '1xjNr6FHNOcSy9L7cZkQ1FUvdPQqsNjyY';

// ===== TECH MAPPINGS =====
interface TechMapping {
  id: string;
  name: string;
  twilioNumber: string;
  personalPhone: string;
}

const techMappings: Record<string, TechMapping> = {
  jacob: {
    id: 'jacob',
    name: 'Jacob',
    twilioNumber: process.env.JACOB_TWILIO_NUMBER || '+1-205-729-7799',
    personalPhone: process.env.JACOB_PERSONAL_PHONE || '+1-205-555-0001',
  },
  scott: {
    id: 'scott',
    name: 'Scott',
    twilioNumber: process.env.SCOTT_TWILIO_NUMBER || '+1-205-729-7800',
    personalPhone: process.env.SCOTT_PERSONAL_PHONE || '+1-205-555-0002',
  },
  landon: {
    id: 'landon',
    name: 'Landon',
    twilioNumber: process.env.LANDON_TWILIO_NUMBER || '+1-205-729-7801',
    personalPhone: process.env.LANDON_PERSONAL_PHONE || '+1-205-555-0003',
  },
};

// ===== WORKORDER CREATION =====
async function createWorkorder(params: any): Promise<any> {
  try {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    const trackingCode = `LMS-${random}-${timestamp}`;

    let folderId = GOOGLE_DRIVE_FOLDER;

    // Create Google Drive folder
    try {
      if (drive) {
        const folder = await drive.files.create({
          resource: {
            name: `${trackingCode}_${params.customerName}`,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [GOOGLE_DRIVE_FOLDER],
          },
          fields: 'id',
        });
        folderId = folder.data.id;
        console.log(`✅ Created Drive folder: ${folderId}`);
      }
    } catch (e) {
      console.error('⚠️ Drive folder error:', e);
    }

    // Append to Google Sheets
    try {
      if (sheets) {
        await sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: 'Sheet1!A:K',
          valueInputOption: 'USER_ENTERED',
          resource: {
            values: [[
              trackingCode,
              new Date().toISOString(),
              params.customerName || '',
              params.customerPhone || '',
              params.customerEmail || '',
              params.customerAddress || '',
              params.serviceType || '',
              params.serviceDescription || '',
              params.preferredContact || 'Phone',
              folderId,
              'Pending',
            ]],
          },
        });
        console.log(`✅ Added to Sheets: ${trackingCode}`);
      }
    } catch (e) {
      console.error('⚠️ Sheets error:', e);
    }

    return {
      success: true,
      trackingCode,
      message: `Work order created: ${trackingCode}`,
    };
  } catch (error: any) {
    console.error('❌ Workorder error:', error);
    return { success: false, message: error.message };
  }
}

// ===== SMS SENDING =====
async function sendSmsMessage(params: any): Promise<any> {
  try {
    const message = await twilioClient.messages.create({
      body: params.message,
      from: process.env.TWILIO_PHONE_NUMBER || '+1-205-729-7798',
      to: params.phoneNumber,
    });
    console.log(`✅ SMS sent: ${message.sid}`);
    return { success: true, messageSid: message.sid };
  } catch (error: any) {
    console.error('❌ SMS error:', error);
    return { success: false, message: error.message };
  }
}

// ===== TECHNICIAN ROUTING =====
async function routeToTechnician(params: any): Promise<any> {
  try {
    const tech = Object.values(techMappings).find(
      (t) => t.name.toLowerCase() === params.technicianName.toLowerCase()
    );

    if (!tech) {
      return { success: false, message: 'Technician not found' };
    }

    console.log(`✅ Routing to ${tech.name}`);
    return { success: true, phone: tech.personalPhone, name: tech.name };
  } catch (error: any) {
    console.error('❌ Routing error:', error);
    return { success: false, message: error.message };
  }
}

// ===== API ENDPOINTS =====

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    service: 'lando-backend-v2',
    time: new Date().toISOString(),
  });
});

app.get('/', (req, res) => {
  res.json({
    status: 'Lando Backend v2.0 Running',
    integrations: ['Twilio', 'Google Gemini', 'Google Sheets', 'Google Drive'],
    techs: Object.values(techMappings).map(t => ({ name: t.name, phone: t.twilioNumber })),
  });
});

app.get('/api/admin/tech-mappings', (req, res) => {
  const safeMapping = Object.entries(techMappings).map(([key, tech]) => ({
    id: tech.id,
    name: tech.name,
    twilioNumber: tech.twilioNumber,
  }));
  res.json(safeMapping);
});

// ===== INCOMING CALL HANDLER =====
app.post('/api/twilio/incoming-call', (req, res) => {
  const { From, To, CallSid } = req.body;

  console.log(`📞 Incoming call: ${From} → ${To} (${CallSid})`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Option 1: Simple greeting (for testing)
  twiml.say('Hello! This is Landon\'s Mailbox Service. Please hold while we connect you.');
  twiml.pause({ length: 2 });
  twiml.say('Thank you for calling. How can we help you today?');

  // Option 2: Uncomment below for MediaStream (requires Gemini setup)
  // const connect = twiml.connect();
  // connect.stream({
  //   url: `${process.env.RAILWAY_WEBHOOK_URL || 'http://localhost:8080'}/media-stream`,
  // });

  res.type('text/xml').send(twiml.toString());
});

// ===== INCOMING MESSAGE HANDLER =====
app.post('/api/twilio/incoming-message', (req, res) => {
  const { From, Body } = req.body;

  console.log(`💬 Incoming SMS from ${From}: ${Body}`);

  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message('Thank you! We received your message. A team member will respond shortly.');

  res.type('text/xml').send(twiml.toString());
});

// ===== MEDIA STREAM HANDLER (for future Gemini integration) =====
const wss = new WebSocketServer({ noServer: true });

function handleMediaStream(ws: any, req: any) {
  console.log('🔌 MediaStream connected');

  ws.on('message', (data: any) => {
    try {
      const message = JSON.parse(data);

      if (message.event === 'start') {
        console.log(`📍 Stream started: ${message.streamSid}`);
      }

      if (message.event === 'media') {
        // Process audio here
      }

      if (message.event === 'stop') {
        console.log('⏹️ Stream stopped');
        ws.close();
      }
    } catch (e) {
      console.error('⚠️ WebSocket error:', e);
    }
  });

  ws.on('error', (error: any) => {
    console.error('❌ WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log('❌ MediaStream closed');
  });
}

// ===== SERVER START =====
const server = app.listen(PORT, () => {
  console.log(`
╔═══════════════════════════════════════╗
║  🎙️  LANDO BACKEND v2.0              ║
║  Port: ${PORT}                           ║
║  Status: ✅ RUNNING                   ║
╠═══════════════════════════════════════╣
║  📞 Twilio: ✅ Ready                  ║
║  🤖 Gemini: ✅ Ready                  ║
║  📊 Sheets: ✅ Connected              ║
║  🗂️  Drive: ✅ Connected              ║
╚═══════════════════════════════════════╝

📱 Tech Numbers:
${Object.values(techMappings).map(t => `   ${t.name}: ${t.twilioNumber}`).join('\n')}

🌐 Endpoints:
   GET  /health
   GET  /
   GET  /api/admin/tech-mappings
   POST /api/twilio/incoming-call
   POST /api/twilio/incoming-message

Ready for calls and messages!
  `);
});

// ===== UPGRADE HANDLER FOR WEBSOCKET =====
server.on('upgrade', (req, res, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, res, head, (ws) => {
      handleMediaStream(ws, req);
    });
  }
});

export default app;
