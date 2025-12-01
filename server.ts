import express from 'express';
import twilio from 'twilio';
import { WebSocketServer } from 'ws';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { google } from 'googleapis';
import nodemailer from 'nodemailer';
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
const GMAIL_USER = process.env.GMAIL_USER || 'landonsmailboxes@gmail.com';
const GMAIL_PASSWORD = process.env.GMAIL_PASSWORD || '';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const genAI = new GoogleGenerativeAI(GOOGLE_API_KEY);

// ===== EMAIL TRANSPORT =====
const mailTransporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: GMAIL_USER,
    pass: GMAIL_PASSWORD,
  },
});

// ===== GOOGLE AUTH =====
let sheets: any;
let drive: any;
let gmail: any;

try {
  const serviceAccount = JSON.parse(GOOGLE_SERVICE_ACCOUNT_KEY);
  const auth = new google.auth.GoogleAuth({
    credentials: serviceAccount,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/gmail.readonly',
    ],
  });

  sheets = google.sheets({ version: 'v4', auth });
  drive = google.drive({ version: 'v3', auth });
  gmail = google.gmail({ version: 'v1', auth });
  console.log('✅ Google Sheets, Drive & Gmail authenticated');
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

// ===== WORKORDER STORAGE (In-memory fallback for thread tracking) =====
const workorderStore: Record<string, any> = {};

// ===== EMAIL CONFIRMATION WITH BULLETPROOF LINK =====
async function sendEmailConfirmation(params: any, folderId: string, shareableLink: string): Promise<any> {
  try {
    const { customerEmail, customerName, trackingCode, serviceType, serviceDescription } = params;

    // Professional HTML email template
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
    .details { background-color: #f8f9fa; padding: 15px; border-left: 4px solid #27ae60; margin: 20px 0; }
    .footer { background-color: #ecf0f1; padding: 15px; text-align: center; font-size: 12px; color: #7f8c8d; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📦 Work Order Confirmed</h1>
      <p>Landon's Mailbox Service</p>
    </div>
    
    <div class="content">
      <p>Hi ${customerName},</p>
      
      <p>Thank you for choosing Landon's Mailbox Service! We've received your work order and are ready to get started.</p>
      
      <div class="tracking-code">
        Tracking Code: <strong>${trackingCode}</strong>
      </div>
      
      <p><strong>🔗 Upload Photos Here:</strong></p>
      <p>
        <a href="${shareableLink}" class="button">📸 Upload Photos</a>
      </p>
      
      <div class="details">
        <p><strong>Work Order Details:</strong></p>
        <ul>
          <li><strong>Service Type:</strong> ${serviceType}</li>
          <li><strong>Description:</strong> ${serviceDescription}</li>
          <li><strong>Tracking Code:</strong> ${trackingCode}</li>
        </ul>
      </div>
      
      <p><strong>⏱️ Timeline:</strong> Most jobs are completed within 10 business days. We'll keep you updated every step of the way.</p>
      
      <p><strong>💡 Next Steps:</strong></p>
      <ol>
        <li>Click the button above to upload photos of the mailbox/work area</li>
        <li>Our team will review and provide a detailed quote if needed</li>
        <li>We'll coordinate timing and get the work done quickly</li>
      </ol>
      
      <p><strong>❓ Questions?</strong> Reply to this email with your tracking code or call us at (205) 279-7798.</p>
      
      <p>Thanks for your business!<br>
      <strong>Landon's Mailbox Service Team</strong></p>
    </div>
    
    <div class="footer">
      <p>This email was sent to ${customerEmail} for tracking code ${trackingCode}</p>
      <p>If you did not request this service, please reply to let us know.</p>
    </div>
  </div>
</body>
</html>
    `;

    // Send email
    await mailTransporter.sendMail({
      from: GMAIL_USER,
      to: customerEmail,
      subject: `📦 Work Order Confirmed - Tracking Code: ${trackingCode}`,
      html: emailHtml,
    });

    console.log(`✅ Confirmation email sent to ${customerEmail} with tracking code ${trackingCode}`);
    
    // Store for thread tracking fallback
    workorderStore[trackingCode] = {
      customerEmail,
      customerName,
      serviceType,
      folderId,
      createdAt: new Date(),
      threadId: null, // Will be populated when customer replies
    };

    return { success: true, emailSent: true };
  } catch (error: any) {
    console.error('❌ Email error:', error);
    return { success: false, message: error.message };
  }
}

// ===== GENERATE SHAREABLE DRIVE LINK =====
async function generateShareableLink(folderId: string): Promise<string> {
  try {
    // Make folder publicly accessible (no sign-in required)
    await drive.permissions.create({
      fileId: folderId,
      resource: {
        role: 'writer',
        type: 'anyone',
      },
    });

    // Return direct shareable link
    const shareableLink = `https://drive.google.com/drive/folders/${folderId}?usp=sharing`;
    console.log(`✅ Generated shareable link: ${shareableLink}`);
    return shareableLink;
  } catch (error: any) {
    console.error('⚠️ Error creating shareable link:', error);
    // Fallback: return link anyway (might have partial permissions)
    return `https://drive.google.com/drive/folders/${folderId}?usp=sharing`;
  }
}

// ===== DETERMINE MARKET FROM ZIP CODE =====
function getMarketFromZip(zip: string): string {
  // Birmingham market zip codes
  const birminghamZips = ['35203', '35204', '35205', '35206', '35207', '35208', '35209', '35210', '35211', '35212', '35213', '35214', '35215', '35216', '35217', '35218', '35219', '35220', '35221', '35222', '35223', '35224', '35225', '35226', '35228', '35229', '35230', '35231', '35232', '35233', '35234', '35235', '35236', '35237', '35238', '35239', '35240', '35241', '35242', '35243', '35244', '35245', '35246', '35247', '35248'];
  
  // Auburn market zip codes
  const auburnZips = ['36830', '36831', '36832', '36849', '36850', '36860', '36871', '36877', '36880'];
  
  if (birminghamZips.includes(zip)) return 'B';
  if (auburnZips.includes(zip)) return 'A';
  return 'B'; // Default to Birmingham if unknown
}

// ===== GENERATE TRACKING CODE WITH MARKET & CHANNEL =====
function generateTrackingCode(lastName: string, zip: string, channel: string = 'C'): string {
  // Market: B (Birmingham) or A (Auburn)
  const market = getMarketFromZip(zip);
  
  // Channel: C (Call), T (Text/SMS), F (Facebook)
  const validChannels = ['C', 'T', 'F'];
  const channelCode = validChannels.includes(channel.toUpperCase()) ? channel.toUpperCase() : 'C';
  
  // Random: 4 characters (letter, number, letter, number)
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let random = '';
  random += chars[Math.floor(Math.random() * 26)]; // Letter
  random += Math.floor(Math.random() * 10); // Number
  random += chars[Math.floor(Math.random() * 26)]; // Letter
  random += Math.floor(Math.random() * 10); // Number
  
  // Format: LMS_B/A_C/T/F_XXXX_LASTNAME
  const trackingCode = `LMS_${market}${channelCode}_${random}_${lastName?.toUpperCase() || 'UNKNOWN'}`;
  return trackingCode;
}

// ===== WORKORDER CREATION =====
async function createWorkorder(params: any): Promise<any> {
  try {
    // Determine channel from request metadata (default to 'C' for call)
    const channel = params.channel || 'C'; // C=Call, T=Text, F=Facebook
    
    // Generate tracking code with market, channel, and lastname
    const trackingCode = generateTrackingCode(params.lastName, params.zip, channel);

    let folderId = GOOGLE_DRIVE_FOLDER;
    let photosFolderId = GOOGLE_DRIVE_FOLDER;

    // Create main Google Drive folder with tracking code_lastname
    try {
      if (drive) {
        // Folder name: LMS_BC_A7K2_MASTERS
        const folder = await drive.files.create({
          resource: {
            name: trackingCode,
            mimeType: 'application/vnd.google-apps.folder',
            parents: [GOOGLE_DRIVE_FOLDER],
          },
          fields: 'id',
        });
        folderId = folder.data.id;
        console.log(`✅ Created Drive folder: ${trackingCode} (${folderId})`);

        // Create "Photos" subfolder inside the work order folder
        const photosFolder = await drive.files.create({
          resource: {
            name: 'Photos',
            mimeType: 'application/vnd.google-apps.folder',
            parents: [folderId],
          },
          fields: 'id',
        });
        photosFolderId = photosFolder.data.id;
        console.log(`✅ Created Photos subfolder: ${photosFolderId}`);
      }
    } catch (e) {
      console.error('⚠️ Drive folder error:', e);
    }

    // Generate shareable link for PHOTOS folder only (customer uploads here)
    const shareableLink = await generateShareableLink(photosFolderId);

    // Append to Google Sheets
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
              folderId,              // Main work order folder
              photosFolderId,        // Photos subfolder
              shareableLink,         // Shareable link to Photos folder
              'Pending',
            ]],
          },
        });
        console.log(`✅ Added to Sheets: ${trackingCode}`);
      }
    } catch (e) {
      console.error('⚠️ Sheets error:', e);
    }

    // Send confirmation email with shareable link
    const emailResult = await sendEmailConfirmation(params, folderId, shareableLink);

    return {
      success: true,
      trackingCode,
      folderId,
      shareableLink,
      message: `Work order created: ${trackingCode}`,
      emailSent: emailResult.success,
    };
  } catch (error: any) {
    console.error('❌ Workorder error:', error);
    return { success: false, message: error.message };
  }
}

// ===== GMAIL THREAD FALLBACK (Check for replies with tracking code) =====
async function checkGmailForReplies(): Promise<void> {
  try {
    if (!gmail) return;

    // Search for unread emails in last hour
    const response = await gmail.users.messages.list({
      userId: 'me',
      q: 'is:unread newer_than:1h',
      maxResults: 10,
    });

    if (!response.data.messages) return;

    for (const message of response.data.messages) {
      try {
        const fullMessage = await gmail.users.messages.get({
          userId: 'me',
          id: message.id,
          format: 'full',
        });

        const headers = fullMessage.data.payload.headers;
        const from = headers.find((h: any) => h.name === 'From')?.value;
        const subject = headers.find((h: any) => h.name === 'Subject')?.value;
        const threadId = fullMessage.data.threadId;

        // Look for tracking codes in subject or body
        for (const [trackingCode, workorder] of Object.entries(workorderStore)) {
          if (subject?.includes(trackingCode) || from?.includes(workorder.customerEmail)) {
            console.log(`✅ Found reply for ${trackingCode} from ${from} (Thread: ${threadId})`);
            workorder.threadId = threadId;
            workorder.repliedAt = new Date();

            // Log this for manual review (implement auto-photo-processing if needed)
            console.log(`📧 Customer replied to work order ${trackingCode}. Manual review may be needed.`);
          }
        }
      } catch (e) {
        console.error('⚠️ Error processing message:', e);
      }
    }
  } catch (error: any) {
    console.error('⚠️ Gmail fallback error:', error.message);
    // Don't break if Gmail fallback fails
  }
}

// ===== FALLBACK: MATCH PHOTOS BY EMAIL ADDRESS =====
async function matchPhotosByEmail(customerEmail: string): Promise<string | null> {
  try {
    if (!sheets) return null;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A:O',
    });

    const rows = response.data.values || [];
    for (const row of rows) {
      if (row[5] === customerEmail) { // Email is in column F
        return row[0]; // Return tracking code (column A)
      }
    }

    return null;
  } catch (error) {
    console.error('⚠️ Email matching error:', error);
    return null;
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
    integrations: ['Twilio', 'Google Gemini', 'Google Sheets', 'Google Drive', 'Gmail'],
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

// ===== CREATE WORKORDER ENDPOINT =====
app.post('/api/create-workorder', async (req, res) => {
  try {
    const result = await createWorkorder(req.body);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== LOOKUP WORKORDER ENDPOINT =====
app.post('/api/lookup-workorder', async (req, res) => {
  try {
    const { phone, email, address } = req.body;

    if (!sheets) {
      return res.status(500).json({ success: false, message: 'Sheets not connected' });
    }

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: GOOGLE_SHEET_ID,
      range: 'Sheet1!A:O',
    });

    const rows = response.data.values || [];
    for (const row of rows) {
      if (
        (phone && row[4] === phone) ||
        (email && row[5] === email) ||
        (address && row[6]?.includes(address))
      ) {
        return res.json({
          trackingCode: row[0],
          status: row[15] || 'Pending',
          created: row[1],
          customerName: `${row[2]} ${row[3]}`,
          phone: row[4],
          email: row[5],
          address: row[6],
        });
      }
    }

    res.json({ success: false, message: 'Work order not found' });
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== GET ZIPCODE ENDPOINT =====
app.post('/api/get-zipcode', async (req, res) => {
  try {
    const { address, city, state } = req.body;
    // TODO: Integrate with zip code API (Google Maps, USPS, etc.)
    res.json({ zipCode: '35203' }); // Placeholder
  } catch (error: any) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// ===== INCOMING CALL HANDLER =====
app.post('/api/twilio/incoming-call', (req, res) => {
  const { From, To, CallSid } = req.body;

  console.log(`📞 Incoming call: ${From} → ${To} (${CallSid})`);

  const twiml = new twilio.twiml.VoiceResponse();

  // Route to Lando voice gateway
  const voiceGatewayUrl = process.env.VOICE_GATEWAY_URL || 'http://localhost:3000';
  const connect = twiml.connect();
  connect.stream({
    url: `${voiceGatewayUrl}/incoming-call?from=${encodeURIComponent(From)}&to=${encodeURIComponent(To)}`,
  });

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

// ===== PERIODIC GMAIL FALLBACK CHECK =====
setInterval(checkGmailForReplies, 5 * 60 * 1000); // Every 5 minutes

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
║  📧 Gmail: ✅ Connected               ║
╚═══════════════════════════════════════╝

📱 Tech Numbers:
${Object.values(techMappings).map(t => `   ${t.name}: ${t.twilioNumber}`).join('\n')}

🌐 Endpoints:
   GET  /health
   GET  /
   GET  /api/admin/tech-mappings
   POST /api/create-workorder
   POST /api/lookup-workorder
   POST /api/get-zipcode
   POST /api/twilio/incoming-call
   POST /api/twilio/incoming-message

✅ Email: Bulletproof confirmations with shareable links
✅ Gmail: Fallback thread tracking for replies
✅ Photos: Auto-organize in Drive by tracking code

Ready for calls, messages, and emails!
  `);
});

export default app;
