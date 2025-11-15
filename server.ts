import express from 'express';
import twilio from 'twilio';
import { Anthropic } from '@anthropic-ai/sdk';
import axios from 'axios';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ===== CONFIGURATION =====
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || '';
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN || '';
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER || '';
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ===== TECH MAPPINGS =====
interface TechMapping {
  name: string;
  twilioNumber: string;
  personalPhone: string;
  businessHoursStart: number;
  businessHoursEnd: number;
}

const techMappings: Record<string, TechMapping> = {
  jacob: {
    name: 'Jacob',
    twilioNumber: '+1-205-729-7799',
    personalPhone: process.env.JACOB_PERSONAL_PHONE || '+1-205-555-0001',
    businessHoursStart: 7,
    businessHoursEnd: 19,
  },
  scott: {
    name: 'Scott',
    twilioNumber: '+1-205-729-7800',
    personalPhone: process.env.SCOTT_PERSONAL_PHONE || '+1-205-555-0002',
    businessHoursStart: 7,
    businessHoursEnd: 19,
  },
};

// ===== UTILITY FUNCTIONS =====

function isBusinessHours(tech: TechMapping): boolean {
  const now = new Date();
  const hour = now.getHours();
  return hour >= tech.businessHoursStart && hour < tech.businessHoursEnd;
}

function getTechByTwilioNumber(twilioNumber: string): TechMapping | null {
  for (const tech of Object.values(techMappings)) {
    if (tech.twilioNumber === twilioNumber) {
      return tech;
    }
  }
  return null;
}

// ===== API ENDPOINTS =====

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'lando-backend-call-routing',
    version: '1.0.0',
  });
});

// Get all tech mappings
app.get('/api/admin/tech-mappings', (req, res) => {
  res.json(techMappings);
});

// Incoming call handler
app.post('/api/twilio/incoming-call', (req, res) => {
  const { From, To, CallSid } = req.body;

  console.log(`📞 Incoming call: ${From} → ${To} (CallSid: ${CallSid})`);

  const tech = getTechByTwilioNumber(To);

  if (!tech) {
    console.error(`❌ Tech not found for number: ${To}`);
    return res.status(404).send('Tech not found');
  }

  const inBusinessHours = isBusinessHours(tech);

  // Build TwiML response
  let twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Say voice="alice">This call may be recorded for quality purposes.</Say>`;

  if (inBusinessHours) {
    // Forward to tech's personal phone
    twiml += `
  <Dial>
    <Number>${tech.personalPhone}</Number>
  </Dial>`;
  } else {
    // Outside business hours - voicemail
    twiml += `
  <Say voice="alice">You've reached ${tech.name}. The office is currently closed. Please leave a message after the beep.</Say>
  <Record maxLength="120" />`;
  }

  twiml += `
</Response>`;

  res.type('text/xml').send(twiml);
});

// Call completed handler
app.post('/api/twilio/call-completed', async (req, res) => {
  const { CallSid, From, To, RecordingUrl, CallDuration } = req.body;

  console.log(`✅ Call completed: ${CallSid}`);
  console.log(`   Duration: ${CallDuration} seconds`);

  try {
    if (RecordingUrl) {
      console.log(`📥 Downloading recording: ${RecordingUrl}`);

      // Download recording
      const recordingResponse = await axios.get(RecordingUrl, {
        auth: {
          username: process.env.TWILIO_ACCOUNT_SID || '',
          password: process.env.TWILIO_AUTH_TOKEN || '',
        },
        responseType: 'arraybuffer',
      });

      // Save locally (for testing)
      const recordingPath = path.join(process.cwd(), `recording_${CallSid}.wav`);
      fs.writeFileSync(recordingPath, recordingResponse.data);
      console.log(`💾 Recording saved: ${recordingPath}`);

      // Send to Claude for transcription
      console.log(`🤖 Sending to Claude for transcription...`);

      const base64Audio = Buffer.from(recordingResponse.data).toString('base64');

      const response = await anthropic.messages.create({
        model: 'claude-3-5-sonnet-20241022',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'text',
                text: 'Please transcribe this phone call recording and provide a brief summary of what was discussed.',
              },
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'audio/wav',
                  data: base64Audio,
                },
              },
            ],
          },
        ],
      });

      const transcription =
        response.content[0].type === 'text' ? response.content[0].text : 'Unable to transcribe';

      console.log(`📝 Transcription: ${transcription.substring(0, 100)}...`);

      // Log call data
      const callData = {
        callSid: CallSid,
        from: From,
        to: To,
        duration: CallDuration,
        timestamp: new Date().toISOString(),
        transcription: transcription,
      };

      console.log(`📋 Call logged:`, callData);
    }

    res.json({ status: 'recorded', callSid: CallSid });
  } catch (error) {
    console.error('❌ Error processing call:', error);
    res.status(500).json({ error: 'Failed to process call' });
  }
});

// WebRTC endpoint (for browser calls)
app.post('/api/webrtc/start-call', async (req, res) => {
  const { customerPhone, techId } = req.body;

  const tech = techMappings[techId];
  if (!tech) {
    return res.status(404).json({ error: 'Tech not found' });
  }

  try {
    // Initiate call via Twilio
    const call = await twilioClient.calls.create({
      from: tech.twilioNumber,
      to: customerPhone,
      url: `${process.env.RAILWAY_WEBHOOK_URL || 'http://localhost:5000'}/api/twilio/incoming-call`,
    });

    res.json({
      status: 'call_initiated',
      callSid: call.sid,
    });
  } catch (error) {
    console.error('❌ Error initiating call:', error);
    res.status(500).json({ error: 'Failed to initiate call' });
  }
});

// ===== START SERVER =====
app.listen(PORT, () => {
  console.log(`
╔════════════════════════════════════════╗
║  🎙️  LANDO BACKEND - CALL ROUTING      ║
║  Port: ${PORT}                             ║
║  Status: ✅ Running                     ║
╚════════════════════════════════════════╝
  `);
});

export default app;