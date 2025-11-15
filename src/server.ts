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
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

const twilioClient = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const anthropic = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

// ===== TECH MAPPINGS =====
interface TechMapping {
  id: string;
  name: string;
  twilioNumber: string;
  personalPhone: string;
  businessHoursStart: number;
  businessHoursEnd: number;
}

const techMappings: Record<string, TechMapping> = {
  jacob: {
    id: 'jacob',
    name: 'Jacob',
    twilioNumber: process.env.JACOB_TWILIO_NUMBER || '+1-205-729-7799',
    personalPhone: process.env.JACOB_PERSONAL_PHONE || '+1-205-555-0001',
    businessHoursStart: 7,
    businessHoursEnd: 19,
  },
  scott: {
    id: 'scott',
    name: 'Scott',
    twilioNumber: process.env.SCOTT_TWILIO_NUMBER || '+1-205-729-7800',
    personalPhone: process.env.SCOTT_PERSONAL_PHONE || '+1-205-555-0002',
    businessHoursStart: 7,
    businessHoursEnd: 19,
  },
  landon: {
    id: 'landon',
    name: 'Landon',
    twilioNumber: process.env.LANDON_TWILIO_NUMBER || '+1-205-729-7801',
    personalPhone: process.env.LANDON_PERSONAL_PHONE || '+1-205-555-0003',
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

function getTechById(techId: string): TechMapping | null {
  return techMappings[techId] || null;
}

// ===== API ENDPOINTS =====

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'OK',
    timestamp: new Date().toISOString(),
    service: 'lando-backend-call-routing',
    version: '1.0.0',
    environment: process.env.NODE_ENV || 'development',
  });
});

// Get all tech mappings
app.get('/api/admin/tech-mappings', (req, res) => {
  const safeMapping = Object.entries(techMappings).map(([key, tech]) => ({
    id: tech.id,
    name: tech.name,
    twilioNumber: tech.twilioNumber,
    businessHours: `${tech.businessHoursStart}AM - ${tech.businessHoursEnd}PM`,
  }));
  res.json(safeMapping);
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
    console.log(`✅ Business hours - forwarding ${From} to ${tech.name} at ${tech.personalPhone}`);
    twiml += `
  <Dial>
    <Number>${tech.personalPhone}</Number>
  </Dial>`;
  } else {
    // Outside business hours - voicemail
    console.log(`🌙 Outside business hours - ${From} sent to voicemail`);
    twiml += `
  <Say voice="alice">You've reached ${tech.name}. The office is currently closed. Please leave a message and your phone number after the beep, and we'll get back to you as soon as possible.</Say>
  <Record maxLength="120" transcribe="true" />`;
  }

  twiml += `
</Response>`;

  res.type('text/xml').send(twiml);
});

// Call completed handler
app.post('/api/twilio/call-completed', async (req, res) => {
  const { CallSid, From, To, RecordingUrl, CallDuration, TranscriptionText } = req.body;

  console.log(`✅ Call completed: ${CallSid}`);
  console.log(`   Duration: ${CallDuration} seconds`);
  console.log(`   From: ${From}`);
  console.log(`   To: ${To}`);

  try {
    const tech = getTechByTwilioNumber(To);
    
    if (!tech) {
      console.error(`⚠️ Tech not found for number: ${To}`);
      return res.status(404).json({ error: 'Tech not found' });
    }

    if (RecordingUrl) {
      console.log(`📥 Processing recording: ${RecordingUrl}`);

      let transcription = TranscriptionText || 'No transcription available';

      // If no transcription from Twilio, try Claude
      if (!TranscriptionText && RecordingUrl) {
        try {
          const recordingResponse = await axios.get(RecordingUrl, {
            auth: {
              username: TWILIO_ACCOUNT_SID,
              password: TWILIO_AUTH_TOKEN,
            },
            responseType: 'arraybuffer',
          });

          const base64Audio = Buffer.from(recordingResponse.data).toString('base64');

          console.log(`🤖 Sending to Claude for transcription...`);

          const response = await anthropic.messages.create({
            model: 'claude-3-5-sonnet-20241022',
            max_tokens: 1024,
            messages: [
              {
                role: 'user',
                content: `This is a base64-encoded WAV audio file from a phone call. Please transcribe it and provide a brief summary of what was discussed.\n\nAudio (base64): ${base64Audio}`,
              },
            ],
          });

          transcription =
            response.content[0].type === 'text'
              ? response.content[0].text
              : 'Unable to transcribe';
        } catch (error) {
          console.error('⚠️ Error with Claude transcription:', error);
          transcription = 'Transcription failed';
        }
      }

      // Log call data
      const callData = {
        callSid: CallSid,
        tech: tech.name,
        from: From,
        to: To,
        duration: CallDuration,
        timestamp: new Date().toISOString(),
        transcription: transcription,
        recordingUrl: RecordingUrl,
      };

      console.log(`📋 Call logged:`, callData);

      res.json({ status: 'recorded', callSid: CallSid, transcription: transcription });
    } else {
      console.log(`ℹ️ No recording for call: ${CallSid}`);
      res.json({ status: 'completed', callSid: CallSid });
    }
  } catch (error) {
    console.error('❌ Error processing call:', error);
    res.status(500).json({ error: 'Failed to process call' });
  }
});

// WebRTC endpoint (for browser calls)
app.post('/api/webrtc/start-call', async (req, res) => {
  const { customerPhone, techId } = req.body;

  console.log(`📞 WebRTC call request: ${customerPhone} to ${techId}`);

  const tech = getTechById(techId);
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

    console.log(`✅ Call initiated: ${call.sid}`);

    res.json({
      status: 'call_initiated',
      callSid: call.sid,
      techName: tech.name,
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
║  Railway URL: ${process.env.RAILWAY_WEBHOOK_URL || 'http://localhost:5000'}
╚════════════════════════════════════════╝
  `);

  console.log('\n📱 Tech Mappings:');
  Object.values(techMappings).forEach(tech => {
    console.log(`   ${tech.name}: ${tech.twilioNumber} → ${tech.personalPhone}`);
  });
});

export default app;