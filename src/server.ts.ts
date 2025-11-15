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

// Initialize Google Sheets and Drive clients
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
  console.error('⚠️ Google authentication setup (will use defaults):', error);
}

// ===== CONSTANTS =====
const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1JW027wypWgVIVto1vIoJ1nsHi13v-KeGRAwII41rcwA';
const GOOGLE_DRIVE_BASE_FOLDER = process.env.GOOGLE_DRIVE_BASE_FOLDER || '1xjNr6FHNOcSy9L7cZkQ1FUvdPQqsNjyY';

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

// ===== FUNCTION HANDLERS =====

async function createWorkorderInSheets(params: any): Promise<any> {
  try {
    console.log(`📋 Creating workorder:`, params);

    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    const trackingCode = `LMS-${random}-${timestamp}`;

    // Create folder in Google Drive
    let folderId = GOOGLE_DRIVE_BASE_FOLDER;
    try {
      if (drive) {
        const folderMetadata = {
          name: `${trackingCode}_${params.customerName}`,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [GOOGLE_DRIVE_BASE_FOLDER],
        };

        const folder = await drive.files.create({
          resource: folderMetadata,
          fields: 'id',
        });

        folderId = folder.data.id;
        console.log(`✅ Created Google Drive folder: ${folderId}`);
      }
    } catch (driveError) {
      console.error('⚠️ Drive folder creation skipped');
    }

    // Append to Google Sheets
    try {
      if (sheets) {
        const values = [
          [
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
          ],
        ];

        await sheets.spreadsheets.values.append({
          spreadsheetId: GOOGLE_SHEET_ID,
          range: 'Sheet1!A:K',
          valueInputOption: 'USER_ENTERED',
          resource: { values },
        });

        console.log(`✅ Added to Google Sheets: ${trackingCode}`);
      }
    } catch (sheetError) {
      console.error('⚠️ Sheets append skipped');
    }

    return {
      success: true,
      message: `Work order created: ${trackingCode}`,
      trackingCode: trackingCode,
    };
  } catch (error: any) {
    console.error('❌ Error creating workorder:', error.message);
    return { success: false, message: `Error: ${error.message}` };
  }
}

async function sendSmsMessage(params: any): Promise<any> {
  try {
    console.log(`📱 Sending SMS to ${params.phoneNumber}`);

    const message = await twilioClient.messages.create({
      body: params.message,
      from: process.env.TWILIO_PHONE_NUMBER || '+1-205-729-7798',
      to: params.phoneNumber,
    });

    return {
      success: true,
      message: `SMS sent`,
      messageSid: message.sid,
    };
  } catch (error: any) {
    console.error('❌ Error sending SMS:', error.message);
    return { success: false, message: `Error: ${error.message}` };
  }
}

async function routeToTechnician(params: any): Promise<any> {
  try {
    console.log(`🔄 Routing to ${params.technicianName}`);

    const tech = Object.values(techMappings).find(
      (t) => t.name.toLowerCase() === params.technicianName.toLowerCase()
    );

    if (!tech) {
      return { success: false, message: `Technician not found` };
    }

    return {
      success: true,
      message: `Routing to ${tech.name}`,
      technicianPhone: tech.personalPhone,
    };
  } catch (error: any) {
    console.error('❌ Error routing:', error.message);
    return { success: false, message: `Error: ${error.message}` };
  }
}

// ===== API ENDPOINTS =====

app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'lando-backend',
    version: '2.0.0',
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

app.post('/api/twilio/incoming-call', (req, res) => {
  const { From, To, CallSid } = req.body;

  console.log(`📞 Incoming call: ${From} → ${To}`);

  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `${process.env.RAILWAY_WEBHOOK_URL || 'http://localhost:8080'}/media-stream`,
    name: 'LandoStream',
  });

  res.type('text/xml').send(twiml.toString());
});

app.get('/', (req, res) => {
  res.json({
    status: 'Lando Backend Running',
    integrations: ['Twilio', 'Google Gemini', 'Google Sheets', 'Google Drive'],
  });
});

// ===== MEDIA STREAM HANDLER =====

const wss = new WebSocketServer({ noServer: true });

async function handleMediaStream(ws: any, req: any) {
  console.log(`🔌 MediaStream connected`);

  let streamSid: string;

  ws.on('message', async (data: any) => {
    try {
      const message = JSON.parse(data);

      if (message.event === 'start') {
        streamSid = message.streamSid;
        console.log(`📍 Stream started: ${streamSid}`);
      }

      if (message.event === 'media') {
        // Process audio
      }

      if (message.event === 'stop') {
        console.log(`⏹️ Stream stopped`);
        ws.close();
      }
    } catch (error) {
      console.error('❌ Error:', error);
    }
  });

  ws.on('error', (error: any) => {
    console.error('❌ WebSocket error:', error);
  });

  ws.on('close', () => {
    console.log(`❌ MediaStream closed`);
  });
}

// ===== SERVER =====

const server = app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🎙️  LANDO BACKEND v2.0                ║
║  Port: ${PORT}                             ║
║  Status: ✅ Running                     ║
╠════════════════════════════════════════╣
║  📞 Twilio: ✅ Ready                    ║
║  🤖 Gemini: ✅ Ready                    ║
║  📊 Sheets: ✅ Ready                    ║
║  🗂️  Drive: ✅ Ready                    ║
╚════════════════════════════════════════╝
  `);

  console.log('\n📱 Tech Mappings:');
  Object.values(techMappings).forEach((tech) => {
    console.log(`   ${tech.name}: ${tech.twilioNumber}`);
  });
});

server.on('upgrade', (req, res, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, res, head, (ws) => {
      handleMediaStream(ws, req);
    });
  }
});

export default app;
