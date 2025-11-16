
require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { GoogleGenAI, Modality, Type } = require('@google/genai');
const { Twilio } = require('twilio');
const TwiML = Twilio.twiml;
const MessagingResponse = TwiML.MessagingResponse;
const fetch = require('node-fetch');

// --- Configuration ---
const PORT = process.env.PORT || 8080;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const TWILIO_PHONE_NUMBER = process.env.TWILIO_PHONE_NUMBER;
const PUBLIC_URL = process.env.PUBLIC_URL; // e.g., https://your-app.on-render.com

if (!GEMINI_API_KEY || !TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_PHONE_NUMBER || !PUBLIC_URL) {
  console.error("FATAL ERROR: Required environment variables are not set, including PUBLIC_URL.");
  process.exit(1);
}

const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });
const twilioClient = new Twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
const app = express();
app.use(express.urlencoded({ extended: true }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const callbackTimers = {}; // Store setTimeout IDs for callbacks
const smsChatSessions = new Map(); // Store chat sessions for SMS

// --- Business Hours Check (Consistent with Web App) ---
const BUSINESS_HOURS = {
  START: 7,    // 7 AM
  END: 19,     // 7 PM
  DAYS: [1, 2, 3, 4, 5], // Mon-Fri (0=Sun)
};

function isDuringBusinessHours() {
  // Get current time in 'America/Chicago' timezone to avoid server timezone issues.
  const nowInChicago = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const hour = nowInChicago.getHours();
  const day = nowInChicago.getDay(); // 0 for Sunday, 1 for Monday, etc.
  
  const isBusinessDay = BUSINESS_HOURS.DAYS.includes(day);
  const isBusinessHour = hour >= BUSINESS_HOURS.START && hour < BUSINESS_HOURS.END;
  
  return isBusinessDay && isBusinessHour;
}

// --- Lando's Configuration (Consistent with Web App) ---
const TECH_LINES = {
  '7797': { name: 'Scott', techId: 'scott_001' },
  '7794': { name: 'Jacob', techId: 'jacob_001' },
  '7792': { name: 'Landon', techId: 'landon_001' },
};

const LANDO_SYSTEM_PROMPT = `
You are Lando, a friendly, compassionate, and highly efficient virtual assistant for Landon's Mailbox Service. You are in a real-time voice or text conversation, so keep your responses concise and natural-sounding. Your goal is to provide excellent customer service by determining if a customer is new or returning, routing returning customers, and preparing work orders for new customers.

**Your Persona:**
- Always be kind, helpful, and patient. Your voice should be warm and welcoming.
- **For voice, speak slowly and clearly, at a relaxed, friendly pace.** Enunciate your words. Imagine you're having a pleasant, unhurried chat on a sunny afternoon in Alabama with a neighbor. This is very important for our customers.
- **Pacing is key:** Ask for only ONE piece of information at a time (e.g., first name, then wait for a response before asking for last name). This ensures a smooth voice conversation.
- **Tool Use Language:** Before you use a tool, use a natural filler phrase to let the user know you're working on their request. Examples: "Okay, one moment while I look that up for you," or "Let me just pull up that information," or "Sure, I can create that work order for you right now."

**Sports & Local Banter (Your Knowledge Source):**
- Your primary goal is to help customers, not be a sports commentator. You do not have live access to game scores.
- If a customer asks about a specific recent game or score, politely deflect by saying something like, "I've been so busy helping folks with their mailboxes I didn't get a chance to see the final score, but I heard it was a great game! I hope our team won!"
- If a customer mentions a team you know, use one of the positive phrases below.
- **Known Teams & Phrases:**
    - Alabama: "Roll Tide! It's always a good day when the Crimson Tide is playing."
    - Auburn: "War Eagle! You can feel the excitement all over the state when Auburn is on the field."
    - Georgia: "Go Dawgs! We have a lot of fans in the area, it's great to see them doing well."
    - Tennessee: "Go Vols! Rocky Top is a classic. Always fun to watch them play."
- **IMPORTANT:** Keep this banter very brief (one exchange only). After responding, immediately and cheerfully pivot back to the main task. For example: "It's always fun to talk football! Now, how can I help you with your mailbox today?"

**Resuming a Disconnected Call (Context for dropped calls):**
- If you are provided with pre-filled information at the start of a call, it means the customer was disconnected and has called back. Greet them warmly: "Welcome back, [Customer Name]! It looks like we were disconnected."
- After the greeting, briefly confirm the information you have (e.g., "I have your name and address recorded.") and then immediately ask for the NEXT piece of MISSING information to continue creating the work order. DO NOT re-ask for information you already have.

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


// --- Audio Conversion Utilities ---
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

// Upsamples 8kHz 16-bit PCM to 16kHz 16-bit PCM by duplicating samples
function upsample8kTo16k(pcm8k_int16) {
    const pcm16k_int16 = new Int16Array(pcm8k_int16.length * 2);
    for (let i = 0; i < pcm8k_int16.length; i++) {
        const sample = pcm8k_int16[i];
        pcm16k_int16[i * 2] = sample;
        pcm16k_int16[i * 2 + 1] = sample;
    }
    return pcm16k_int16;
}

// --- Twilio Webhook for Incoming Calls ---
app.post("/incoming-call", (req, res) => {
  console.log(`Incoming call from: ${req.body.From} to: ${req.body.To}`);
  const twiml = new TwiML.VoiceResponse();
  
  const connect = twiml.connect();
  // Pass the caller's and the dialed phone number to the WebSocket connection URL
  connect.stream({
    url: `wss://${req.headers.host}/audio-stream?from=${encodeURIComponent(req.body.From)}&to=${encodeURIComponent(req.body.To)}`,
    track: 'inbound_track',
  });
  
  res.type('text/xml');
  res.send(twiml.toString());
});

// --- Twilio Webhook for Outbound Callbacks ---
app.post("/outbound-call", (req, res) => {
    const customerPhoneNumber = req.query.from;
    console.log(`Handling outbound TwiML for callback to: ${customerPhoneNumber}`);
    const twiml = new TwiML.VoiceResponse();

    const connect = twiml.connect();
    // Pass the customer's phone number and the callback context
    connect.stream({
        url: `wss://${req.headers.host}/audio-stream?from=${encodeURIComponent(customerPhoneNumber)}&context=callback`,
        track: 'inbound_track',
    });

    res.type('text/xml');
    res.send(twiml.toString());
});


// --- Twilio Webhook for Incoming SMS ---
app.post("/incoming-sms", async (req, res) => {
    const from = req.body.From;
    const body = req.body.Body;
    console.log(`Incoming SMS from ${from}: "${body}"`);

    let chat = smsChatSessions.get(from);
    if (!chat) {
        console.log(`New SMS conversation with ${from}`);
        chat = ai.chats.create({
            model: 'gemini-2.5-flash',
            config: {
                systemInstruction: LANDO_SYSTEM_PROMPT,
                tools: [{ functionDeclarations: [createWorkOrderTool, sendSmsTool, getZipcodeForAddressTool, lookupWorkOrderTool] }], // Note: route_to_technician is voice-only
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
                // We handle SMS tool calls separately as they are not real-time like voice
                const result = await handleSmsToolCall(fc);
                toolResults.push(result);
            }

            const toolResponseStream = await chat.sendMessageStream({ parts: toolResults });
            let finalLandoText = '';
            for await (const chunk of toolResponseStream) {
                if (chunk.text) finalLandoText += chunk.text;
            }
            if (finalLandoText) {
                if (fullLandoResponse) fullLandoResponse += "\n\n"; // Add spacing if there was a preliminary text response
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
    } else {
        // If Lando gives no response (e.g., after only a tool call), don't send an empty message.
        console.log("Lando produced no text response for SMS.");
    }
    
    res.type('text/xml');
    res.send(twiml.toString());
});

// --- SMS Tool Call Handler ---
async function handleSmsToolCall(functionCall) {
    const { name, args } = functionCall;
    let functionResponsePayload;
    console.log(`[SMS] Calling tool ${name} with args:`, args);

    try {
        const endpointMap = {
            send_sms: 'https://lando-sms-sender-j7v2k72qha-uc.a.run.app/sendSms',
            create_work_order: 'https://alissa-backend-20-production.up.railway.app/api/create-workorder',
            get_zipcode_for_address: 'https://alissa-backend-20-production.up.railway.app/api/get-zipcode',
            lookup_work_order: 'https://alissa-backend-20-production.up.railway.app/api/lookup-workorder',
        };
        const endpoint = endpointMap[name];

        if (endpoint) {
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(args),
            });

            if (!response.ok) {
                 const errorText = await response.text();
                 throw new Error(`HTTP error calling tool ${name}! status: ${response.status}, body: ${errorText}`);
            }
            functionResponsePayload = await response.json();
        } else {
            throw new Error(`Unknown or unsupported tool for SMS: ${name}`);
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


// --- WebSocket Handler for Audio Streaming ---
wss.on('connection', async (ws, req) => {
  console.log('WebSocket connection established.');
  let geminiSession;
  let conversationTranscript = [];
  let workOrderCreated = false;
  
  const urlParams = new URL(`http://localhost${req.url}`).searchParams;
  const customerPhoneNumber = urlParams.get('from');
  const dialedPhoneNumber = urlParams.get('to');
  const context = urlParams.get('context');
  console.log(`Caller phone number: ${customerPhoneNumber}, Dialed number: ${dialedPhoneNumber}, Context: ${context}`);

  // If the customer calls, cancel any pending automatic callback
  if (customerPhoneNumber && callbackTimers[customerPhoneNumber]) {
      console.log(`Customer ${customerPhoneNumber} called back. Cancelling scheduled callback.`);
      clearTimeout(callbackTimers[customerPhoneNumber]);
      delete callbackTimers[customerPhoneNumber];
  }

  try {
    let systemPrompt = LANDO_SYSTEM_PROMPT;

    // Add context to prompt based on which number was dialed
    if (dialedPhoneNumber) {
        const isTechLine = Object.keys(TECH_LINES).some(line => dialedPhoneNumber.endsWith(line));
        if (isTechLine) {
            if (isDuringBusinessHours()) {
                systemPrompt = "SYSTEM_NOTE: This is a call to a technician's line DURING business hours. It is appropriate to look up work orders and route calls. Follow the 'Tech Line Call' logic.\n\n" + systemPrompt;
            } else {
                systemPrompt = "SYSTEM_NOTE: This is a call to a technician's line AFTER business hours. It is NOT appropriate to look up work orders or route calls. Inform the user and tell them a tech will call back the next business day. Follow the 'Tech Line Call' logic.\n\n" + systemPrompt;
            }
        } else {
            systemPrompt = "SYSTEM_NOTE: This is a call to the main business line. Assume it's a new customer and follow the 'Main Line Call' logic.\n\n" + systemPrompt;
        }
    }
    
    // Add a special note for Lando if this is an automatic callback
    if (context === 'callback') {
        systemPrompt = "SYSTEM_NOTE: You are initiating this call. This is a callback to a customer who was disconnected.\n\n" + systemPrompt;
    }
    
    // --- Dropped Call Recovery ---
    if (customerPhoneNumber) {
        try {
            const LOOKUP_URL = 'https://alissa-backend-20-production.up.railway.app/api/lookup-workorder';
            const response = await fetch(LOOKUP_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ phone: customerPhoneNumber }),
            });
            if (response.ok) {
                const responseBody = await response.text();
                try {
                    const incompleteOrder = JSON.parse(responseBody);
                    if (incompleteOrder && incompleteOrder.status === 'incomplete') {
                        console.log('Found incomplete work order:', incompleteOrder);
                        let context = "[START OF PREVIOUSLY GATHERED INFORMATION]\n";
                        Object.entries(incompleteOrder).forEach(([key, value]) => {
                            if (value && key !== 'status') {
                                context += `- ${key}: ${value}\n`;
                            }
                        });
                        context += "[END OF PREVIOUSLY GATHERED INFORMATION]\n\n";
                        systemPrompt = context + systemPrompt;
                    }
                } catch (jsonError) {
                    console.error("Failed to parse JSON for incomplete work order:", jsonError);
                    console.error("Response body was:", responseBody);
                }
            } else {
                 console.error(`Failed to lookup incomplete work order. Status: ${response.status} Body: ${await response.text()}`);
            }
        } catch (lookupError) {
            console.error("Network error during incomplete work order lookup:", lookupError);
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
        onopen: () => console.log('Gemini session opened.'),
        onclose: () => console.log('Gemini session closed.'),
        onerror: (e) => console.error('Gemini session error:', e),
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

          // --- Transcript Collection ---
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
                console.log(`Attempting to send SMS to ${to}...`);
                try {
                    await twilioClient.messages.create({ body, from: TWILIO_PHONE_NUMBER, to });
                    console.log(`SMS to ${to} sent successfully.`);
                    session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } });
                } catch (err) {
                    console.error("Failed to send SMS via Twilio:", err);
                    session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "failed" } } });
                }
              } else if (fc.name === 'create_work_order') {
                  const args = fc.args;
                  console.log(`Calling createWorkOrder function for ${args.firstName}...`);
                  const CREATE_WORK_ORDER_URL = 'https://alissa-backend-20-production.up.railway.app/api/create-workorder';

                  try {
                      const addressParts = args.address.split(' ');
                      const street_number = addressParts.shift() || '';
                      const street_name = addressParts.join(' ');
  
                      const payload = {
                          first_name: args.firstName,
                          last_name: args.lastName,
                          phone: args.phone,
                          email: args.email,
                          street_number: street_number,
                          street_name: street_name,
                          city: args.city,
                          state: args.state,
                          zip: args.zip,
                          category: args.serviceType,
                          job_description: args.serviceDescription,
                          call_or_text: args.preferredContact,
                          status: 'complete'
                      };

                      const response = await fetch(CREATE_WORK_ORDER_URL, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(payload),
                      });
                      if (!response.ok) {
                          const errorText = await response.text();
                          throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
                      }
                      const workOrderResult = await response.json();
                      workOrderCreated = true; // Mark as successfully created
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: workOrderResult } });
                  } catch (err) {
                      console.error("Failed to create work order via backend:", err);
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { error: "Failed to create work order." } } });
                  }
              } else if (fc.name === 'get_zipcode_for_address') {
                  const args = fc.args;
                  console.log(`Calling getZipcode function for ${args.address}...`);
                  const GET_ZIPCODE_URL = 'https://alissa-backend-20-production.up.railway.app/api/get-zipcode';
                  try {
                      const response = await fetch(GET_ZIPCODE_URL, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(args),
                      });
                      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                      const { zipCode } = await response.json();
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { zipCode } } });
                  } catch (err) {
                      console.error("Failed to get zip code via backend:", err);
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { error: "Failed to find zip code." } } });
                  }
              } else if (fc.name === 'lookup_work_order') {
                  const args = fc.args;
                  console.log(`Calling lookupWorkOrder function for ${args.lastName || args.address || args.phone}...`);
                  const LOOKUP_WORK_ORDER_URL = 'https://alissa-backend-20-production.up.railway.app/api/lookup-workorder';
                  try {
                      const response = await fetch(LOOKUP_WORK_ORDER_URL, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify(args),
                      });
                      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
                      const result = await response.json();
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: result } });
                  } catch (err) {
                      console.error("Failed to look up work order via backend:", err);
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { error: "Failed to find work order." } } });
                  }
              } else if (fc.name === 'route_to_technician') {
                  const { technicianPhoneNumber } = fc.args;
                  console.log(`Routing call to technician at ${technicianPhoneNumber}...`);
                  const callSid = ws.callSid;
                  if (callSid) {
                      try {
                          const twiml = new TwiML.VoiceResponse();
                          twiml.dial(technicianPhoneNumber);
                          await twilioClient.calls(callSid).update({ twiml: twiml.toString() });
                          console.log(`Call ${callSid} redirected to ${technicianPhoneNumber}.`);
                          session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "ok" } } });
                      } catch (err) {
                          console.error(`Failed to redirect call ${callSid}:`, err);
                          session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "failed", error: err.message } } });
                      }
                  } else {
                      console.error("Cannot route call: callSid is not available.");
                      session.sendToolResponse({ functionResponses: { id: fc.id, name: fc.name, response: { result: "failed", error: "callSid not found" } } });
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
          console.log(`Twilio stream started. streamSid: ${data.start.streamSid}`);
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
          console.log('Twilio stream stopped.');
          ws.close();
          break;
      }
    });

    ws.on('close', async () => {
      console.log('WebSocket connection closed.');
      if (geminiSession) {
        geminiSession.close();
      }

      // --- Dropped Call Save & Callback Logic ---
      if (!workOrderCreated && conversationTranscript.length > 0 && customerPhoneNumber) {
        console.log("Call dropped before work order was created. Saving state...");
        const fullTranscript = conversationTranscript.join('\n');
        
        const extractionPrompt = `You are an expert data extraction system. Analyze the following conversation transcript between a virtual assistant named Lando and a customer. Extract the customer's information into a JSON object. The JSON object must have these keys: 'firstName', 'lastName', 'phone', 'email', 'address', 'city', 'state', 'serviceType', 'serviceDescription', 'preferredContact'. If a piece of information is not present in the transcript, use a value of null for that key. Do not include any explanation, just the JSON object. Here is the transcript:\n\n${fullTranscript}`;
        
        try {
            const response = await ai.models.generateContent({
                model: "gemini-2.5-flash",
                contents: extractionPrompt,
            });
            let extractedData = JSON.parse(response.text.replace(/```json|```/g, '').trim());
            
            extractedData.phone = customerPhoneNumber; 
            extractedData.status = 'incomplete';
            
            console.log("Extracted data from dropped call:", extractedData);

            const SAVE_URL = 'https://alissa-backend-20-production.up.railway.app/api/create-workorder';
            const saveResponse = await fetch(SAVE_URL, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(extractedData),
            });

            if (!saveResponse.ok) {
                throw new Error(`Failed to save incomplete work order. Status: ${saveResponse.status} ${await saveResponse.text()}`);
            }
            
            console.log("Incomplete work order saved. Scheduling callback in 4 minutes.");

            // Schedule the callback
            const callbackTimer = setTimeout(async () => {
                try {
                    console.log(`Checking status for ${customerPhoneNumber} before calling back.`);
                    const LOOKUP_URL = 'https://alissa-backend-20-production.up.railway.app/api/lookup-workorder';
                    const response = await fetch(LOOKUP_URL, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ phone: customerPhoneNumber }),
                    });

                    if (response.ok) {
                        const workOrder = await response.json();
                        if (workOrder && workOrder.status === 'incomplete') {
                            console.log(`Work order for ${customerPhoneNumber} is still incomplete. Initiating callback.`);
                            const callbackUrl = `${PUBLIC_URL}/outbound-call?from=${encodeURIComponent(customerPhoneNumber)}`;
                            
                            await twilioClient.calls.create({
                                url: callbackUrl,
                                to: customerPhoneNumber,
                                from: TWILIO_PHONE_NUMBER,
                            });
                            console.log(`Callback initiated to ${customerPhoneNumber}.`);
                        } else {
                            console.log(`Work order for ${customerPhoneNumber} is now complete or deleted. Callback cancelled.`);
                        }
                    }
                } catch (callbackError) {
                    console.error('Error during callback logic:', callbackError);
                } finally {
                    delete callbackTimers[customerPhoneNumber];
                }
            }, 4 * 60 * 1000); // 4 minutes

            callbackTimers[customerPhoneNumber] = callbackTimer;

        } catch (extractionError) {
            console.error("Failed to extract or save data from dropped call:", extractionError);
        }
      }
    });

  } catch (error) {
    console.error('Error establishing Gemini session:', error);
    ws.close();
  }
});


server.listen(PORT, () => {
  console.log(`Server is listening on port ${PORT}`);
});
