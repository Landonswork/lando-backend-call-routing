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

const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY || '';
const GOOGLE_SERVICE_ACCOUNT_KEY = process.env.GOOGLE_SERVICE_ACCOUNT_KEY || '';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

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
  console.log('✅ Google authenticated');
} catch (error) {
  console.error('⚠️ Google setup skipped');
}

const GOOGLE_SHEET_ID = process.env.GOOGLE_SHEET_ID || '1JW027wypWgVIVto1vIoJ1nsHi13v-KeGRAwII41rcwA';
const GOOGLE_DRIVE_FOLDER = process.env.GOOGLE_DRIVE_BASE_FOLDER || '1xjNr6FHNOcSy9L7cZkQ1FUvdPQqsNjyY';

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

async function createWorkorder(params: any): Promise<any> {
  try {
    const timestamp = Date.now();
    const random = Math.random().toString(36).substring(2, 6).toUpperCase();
    const trackingCode = `LMS-${random}-${timestamp}`;

    let folderId = GOOGLE_DRIVE_FOLDER;
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
      }
    } catch (e) {
      console.error('Drive error:', e);
    }

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
      }
    } catch (e) {
      console.error('Sheets error:', e);
    }

    return { success: true, trackingCode, message: `Order created: ${trackingCode}` };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

async function sendSms(params: any): Promise<any> {
  try {
    const message = await twilioClient.messages.create({
      body: params.message,
      from: process.env.TWILIO_PHONE_NUMBER || '+1-205-729-7798',
      to: params.phoneNumber,
    });
    return { success: true, messageSid: message.sid };
  } catch (error: any) {
    return { success: false, message: error.message };
  }
}

async function routeTech(params: any): Promise<any> {
  const tech = Object.values(techMappings).find(
    (t) => t.name.toLowerCase() === params.technicianName.toLowerCase()
  );
  if (!tech) return { success: false, message: 'Technician not found' };
  return { success: true, phone: tech.personalPhone };
}

app.get('/health', (req, res) => {
  res.json({ status: 'OK', service: 'lando-backend-v2' });
});

app.get('/', (req, res) => {
  res.json({ status: 'Running', integrations: ['Twilio', 'Gemini', 'Sheets', 'Drive'] });
});

app.post('/api/twilio/incoming-call', (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  const connect = twiml.connect();
  connect.stream({
    url: `${process.env.RAILWAY_WEBHOOK_URL || 'http://localhost:8080'}/media-stream`,
  });
  res.type('text/xml').send(twiml.toString());
});

const wss = new WebSocketServer({ noServer: true });

function handleMediaStream(ws: any, req: any) {
  console.log('MediaStream connected');
  ws.on('message', (data: any) => {
    try {
      const message = JSON.parse(data);
      if (message.event === 'stop') {
        ws.close();
      }
    } catch (e) {
      console.error('Error:', e);
    }
  });
}

const server = app.listen(PORT, () => {
  console.log(`Lando Backend v2.0 running on port ${PORT}`);
});

server.on('upgrade', (req, res, head) => {
  if (req.url === '/media-stream') {
    wss.handleUpgrade(req, res, head, (ws) => {
      handleMediaStream(ws, req);
    });
  }
});

export default app;
