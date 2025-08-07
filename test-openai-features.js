/**
 * Test script for OpenAI Response Format and Predicted Outputs features
 * Run this after starting the server with: npm run dev
 */

const API_URL = 'http://localhost:3000/v1/chat/completions';

// Test 1: Structured Output with JSON Schema
async function testStructuredOutput() {
  console.log('\n🧪 Test 1: Structured Output with JSON Schema');
  
  const request = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: 'Extract the key information from this text: "John Smith is a 28-year-old software engineer living in San Francisco. He works at TechCorp and has 5 years of experience."'
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'person_info',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            age: { type: 'number' },
            occupation: { type: 'string' },
            location: { type: 'string' },
            company: { type: 'string' },
            experience_years: { type: 'number' }
          },
          required: ['name', 'age', 'occupation']
        }
      }
    }
  };

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key'
      },
      body: JSON.stringify(request)
    });

    const data = await response.json();
    console.log('✅ Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Test 2: JSON Mode (json_object)
async function testJsonMode() {
  console.log('\n🧪 Test 2: JSON Mode (json_object)');
  
  const request = {
    model: 'gpt-3.5-turbo',
    messages: [
      {
        role: 'user',
        content: 'List 3 programming languages with their main use cases in JSON format.'
      }
    ],
    response_format: {
      type: 'json_object'
    }
  };

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key'
      },
      body: JSON.stringify(request)
    });

    const data = await response.json();
    console.log('✅ Response:', JSON.stringify(data, null, 2));
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Test 3: Predicted Outputs
async function testPredictedOutput() {
  console.log('\n🧪 Test 3: Predicted Outputs for Code Editing');
  
  const originalCode = `function calculateTotal(items) {
  let sum = 0;
  for (let item of items) {
    sum += item.price;
  }
  return sum;
}`;

  const request = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: 'Change the variable name from "sum" to "total" in this code:'
      },
      {
        role: 'user',
        content: originalCode
      }
    ],
    prediction: {
      type: 'content',
      content: originalCode.replace(/sum/g, 'total')
    }
  };

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key'
      },
      body: JSON.stringify(request)
    });

    const data = await response.json();
    console.log('✅ Response:', JSON.stringify(data, null, 2));
    
    // Note: With prediction, the response should be ~3X faster
    console.log('💡 Note: Predicted outputs should return ~3X faster than normal');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Test 4: Streaming with Structured Output
async function testStreamingStructuredOutput() {
  console.log('\n🧪 Test 4: Streaming with Structured Output');
  
  const request = {
    model: 'gpt-4o-mini',
    messages: [
      {
        role: 'user',
        content: 'Generate a TODO list with 3 items in JSON format'
      }
    ],
    response_format: {
      type: 'json_schema',
      json_schema: {
        name: 'todo_list',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            todos: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'number' },
                  task: { type: 'string' },
                  priority: { type: 'string', enum: ['low', 'medium', 'high'] }
                },
                required: ['id', 'task', 'priority']
              }
            }
          },
          required: ['todos']
        }
      }
    },
    stream: true
  };

  try {
    const response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer test-key'
      },
      body: JSON.stringify(request)
    });

    console.log('📡 Streaming response:');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      const chunk = decoder.decode(value);
      process.stdout.write(chunk);
    }
    console.log('\n✅ Stream completed');
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// Run all tests
async function runTests() {
  console.log('🚀 Starting OpenAI Features Tests');
  console.log('================================');
  
  await testStructuredOutput();
  await testJsonMode();
  await testPredictedOutput();
  await testStreamingStructuredOutput();
  
  console.log('\n================================');
  console.log('✨ All tests completed!');
}

// Check if server is running
async function checkServer() {
  try {
    const response = await fetch('http://localhost:3000/health');
    if (!response.ok) {
      throw new Error('Server not responding');
    }
    return true;
  } catch (error) {
    console.error('❌ Server is not running. Please start it with: npm run dev');
    return false;
  }
}

// Main
(async () => {
  const serverRunning = await checkServer();
  if (serverRunning) {
    await runTests();
  }
})();