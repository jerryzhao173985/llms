#!/usr/bin/env node

/**
 * Test o3 model with correct parameter names
 * o3 models use max_completion_tokens instead of max_tokens
 */

import https from 'https';

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

if (!OPENAI_API_KEY) {
  console.error('❌ Error: OPENAI_API_KEY environment variable not set');
  process.exit(1);
}

function callOpenAI(requestBody) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(requestBody);
    
    const options = {
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Length': data.length
      }
    };

    const req = https.request(options, (res) => {
      let responseBody = '';
      
      res.on('data', (chunk) => {
        responseBody += chunk;
      });
      
      res.on('end', () => {
        try {
          const json = JSON.parse(responseBody);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`API Error (${res.statusCode}): ${json.error?.message || responseBody}`));
          }
        } catch (e) {
          reject(new Error(`Parse error: ${responseBody}`));
        }
      });
    });

    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// Test o3-mini with correct parameters
async function testO3WithCorrectParams() {
  console.log('\n🎯 Testing o3-mini with max_completion_tokens');
  console.log('=' .repeat(50));
  
  try {
    const response = await callOpenAI({
      model: 'o3-mini',
      messages: [
        {
          role: 'user',
          content: 'Return a simple JSON object with a greeting field'
        }
      ],
      max_completion_tokens: 100  // Use this instead of max_tokens
    });
    
    console.log('✅ o3-mini model IS AVAILABLE!');
    console.log('Model:', response.model);
    console.log('Response:', response.choices[0].message.content);
    console.log('\n⚠️ Important: o3 models use max_completion_tokens, not max_tokens');
    
    return true;
  } catch (error) {
    console.error('❌ Error:', error.message);
    return false;
  }
}

// Test o3-mini with JSON Mode using correct params
async function testO3JsonModeCorrect() {
  console.log('\n🧪 Testing o3-mini with JSON Mode (response_format)');
  console.log('=' .repeat(50));
  
  try {
    const response = await callOpenAI({
      model: 'o3-mini',
      messages: [
        {
          role: 'user',
          content: 'Create a JSON object with name and age fields for a person'
        }
      ],
      response_format: { type: 'json_object' },
      max_completion_tokens: 100
    });
    
    console.log('✅ JSON Mode works with o3-mini!');
    console.log('Response:', response.choices[0].message.content);
    
    const parsed = JSON.parse(response.choices[0].message.content);
    console.log('Parsed JSON:', parsed);
    
    return true;
  } catch (error) {
    if (error.message.includes('response_format')) {
      console.log('⚠️ o3-mini may not support response_format parameter');
      console.log('Error:', error.message);
    } else {
      console.error('❌ Error:', error.message);
    }
    return false;
  }
}

// Test o3-mini with structured output
async function testO3StructuredOutputCorrect() {
  console.log('\n🧪 Testing o3-mini with Structured Output (json_schema)');
  console.log('=' .repeat(50));
  
  try {
    const response = await callOpenAI({
      model: 'o3-mini',
      messages: [
        {
          role: 'user',
          content: 'Generate a person object with name (string) and age (number)'
        }
      ],
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'person',
          strict: true,
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              age: { type: 'integer' }
            },
            required: ['name', 'age'],
            additionalProperties: false
          }
        }
      },
      max_completion_tokens: 100
    });
    
    console.log('✅ Structured Output works with o3-mini!');
    console.log('Response:', response.choices[0].message.content);
    
    const parsed = JSON.parse(response.choices[0].message.content);
    console.log('Parsed:', parsed);
    console.log('Schema compliance: ✅');
    
    return true;
  } catch (error) {
    if (error.message.includes('response_format') || error.message.includes('json_schema')) {
      console.log('⚠️ o3-mini may not support json_schema response format');
      console.log('Error details:', error.message);
    } else {
      console.error('❌ Error:', error.message);
    }
    return false;
  }
}

// Update our transformer to handle o3 models
function showTransformerUpdate() {
  console.log('\n📝 Required Transformer Update for o3 Support:');
  console.log('=' .repeat(50));
  console.log(`
// In openai.transformer.ts or a new o3.transformer.ts:

export class O3Transformer implements Transformer {
  name = "o3";
  
  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    // Convert max_tokens to max_completion_tokens for o3 models
    if (request.model.includes('o3')) {
      const modifiedRequest = { ...request };
      
      if (modifiedRequest.max_tokens) {
        modifiedRequest.max_completion_tokens = modifiedRequest.max_tokens;
        delete modifiedRequest.max_tokens;
      }
      
      return modifiedRequest;
    }
    
    return request;
  }
}
`);
}

// Main test runner
async function runTests() {
  console.log('🚀 OpenAI o3 Model Testing - Correct Parameters');
  console.log('=' .repeat(50));
  console.log('Timestamp:', new Date().toISOString());
  
  // Test basic o3-mini availability
  const o3Works = await testO3WithCorrectParams();
  
  if (o3Works) {
    // Test response format features
    await testO3JsonModeCorrect();
    await testO3StructuredOutputCorrect();
  }
  
  // Show required transformer update
  showTransformerUpdate();
  
  console.log('\n' + '='.repeat(50));
  console.log('📊 Summary:');
  console.log('=' .repeat(50));
  
  if (o3Works) {
    console.log('✅ o3-mini model is AVAILABLE');
    console.log('⚠️ Uses max_completion_tokens instead of max_tokens');
    console.log('🔧 Need to update transformer to handle this difference');
  }
  
  console.log('\n💡 Key Finding:');
  console.log('o3 models require max_completion_tokens parameter');
  console.log('This is different from other OpenAI models');
  console.log('We need a specific transformer to handle o3 models');
}

runTests().catch(console.error);