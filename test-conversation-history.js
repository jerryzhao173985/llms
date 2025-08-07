#!/usr/bin/env node

async function testConversationHistory() {
  console.log('Testing OpenAI Responses API with conversation history...\n');
  
  // Test with conversation history (this is where the error occurs)
  const requestWithHistory = {
    model: "openai-responses,o4-mini",
    messages: [
      {
        role: "user",
        content: "What is 2+2?"
      },
      {
        role: "assistant", 
        content: "4"
      },
      {
        role: "user",
        content: "What did I just ask you?"
      }
    ],
    max_tokens: 100
  };

  console.log('Sending request with conversation history...');
  console.log('Messages:', JSON.stringify(requestWithHistory.messages, null, 2));
  
  try {
    const response = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(requestWithHistory)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('\n❌ Error with conversation history:');
      console.error(error);
      
      // Try to parse and show the specific error
      try {
        const errorObj = JSON.parse(error);
        if (errorObj.error?.message?.includes('input_text')) {
          console.log('\n⚠️  Content type error detected!');
          console.log('The assistant message is not being transformed correctly.');
          console.log('Assistant messages should use "output_text", not "input_text"');
        }
      } catch (e) {}
      
      return false;
    }

    const data = await response.json();
    console.log('\n✅ Success with conversation history!');
    console.log('Response:', data.choices?.[0]?.message?.content);
    return true;
    
  } catch (error) {
    console.error('\n❌ Request failed:', error.message);
    return false;
  }
}

// Simple test without history (should work)
async function testSimpleRequest() {
  console.log('\nTesting simple request without history...');
  
  const simpleRequest = {
    model: "openai-responses,o4-mini",
    messages: [
      {
        role: "user",
        content: "What is 3+3?"
      }
    ],
    max_tokens: 10
  };

  try {
    const response = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(simpleRequest)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Simple request failed:', error);
      return false;
    }

    const data = await response.json();
    console.log('✅ Simple request succeeded! Response:', data.choices?.[0]?.message?.content);
    return true;
    
  } catch (error) {
    console.error('Request failed:', error.message);
    return false;
  }
}

async function runTests() {
  console.log('====================================');
  console.log('Testing Responses API Conversation History Fix');
  console.log('====================================\n');
  
  // First test simple request
  const simpleSuccess = await testSimpleRequest();
  
  // Then test with conversation history
  const historySuccess = await testConversationHistory();
  
  console.log('\n====================================');
  console.log('Test Results:');
  console.log(`Simple request: ${simpleSuccess ? '✅ PASSED' : '❌ FAILED'}`);
  console.log(`Conversation history: ${historySuccess ? '✅ PASSED' : '❌ FAILED'}`);
  console.log('====================================');
  
  if (!historySuccess) {
    console.log('\n⚠️  The transformer needs to properly convert:');
    console.log('  - User messages: content type = "input_text"');
    console.log('  - Assistant messages: content type = "output_text"');
    console.log('  - System messages: content type = "input_text"');
  }
}

// Run the tests
runTests();