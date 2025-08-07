#!/usr/bin/env node

async function testAPI() {
  const request = {
    model: "openai-chat,gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: "What is 2+2? Reply with just the number."
      }
    ],
    max_tokens: 10
  };

  try {
    console.log('Sending request to llms server...');
    const response = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error('Error response:', error);
      return;
    }

    const data = await response.json();
    console.log('Success! Response:', JSON.stringify(data, null, 2));
    
    if (data.choices && data.choices[0]) {
      console.log('\nAssistant said:', data.choices[0].message.content);
    }
  } catch (error) {
    console.error('Request failed:', error.message);
  }
}

// Start the test
testAPI();