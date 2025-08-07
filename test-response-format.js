#!/usr/bin/env node

async function testResponseFormat() {
  console.log('Testing OpenAI Response Format Features...\n');
  
  // Test 1: JSON Object Mode
  console.log('1. Testing JSON Object Mode...');
  const jsonObjectRequest = {
    model: "openai-chat,gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: "List three colors in JSON format with keys: color1, color2, color3"
      }
    ],
    response_format: {
      type: "json_object"
    },
    max_tokens: 100
  };

  await makeRequest(jsonObjectRequest, 'JSON Object Mode');

  // Test 2: Structured Output with JSON Schema
  console.log('\n2. Testing Structured Output (json_schema)...');
  const structuredRequest = {
    model: "openai-chat,gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: "Generate information about a book"
      }
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "book_info",
        strict: true,
        schema: {
          type: "object",
          properties: {
            title: { type: "string" },
            author: { type: "string" },
            year: { type: "integer" },
            genres: {
              type: "array",
              items: { type: "string" }
            }
          },
          required: ["title", "author", "year", "genres"],
          additionalProperties: false
        }
      }
    },
    max_tokens: 200
  };

  await makeRequest(structuredRequest, 'Structured Output');

  // Test 3: Predicted Output (for code editing)
  console.log('\n3. Testing Predicted Output...');
  const predictedRequest = {
    model: "openai-chat,gpt-4o-mini",
    messages: [
      {
        role: "user",
        content: "Update this function to add error handling:\n\nfunction divide(a, b) {\n  return a / b;\n}"
      }
    ],
    prediction: {
      type: "content",
      content: "function divide(a, b) {\n  return a / b;\n}"
    },
    max_tokens: 200
  };

  await makeRequest(predictedRequest, 'Predicted Output');
}

async function makeRequest(request, testName) {
  try {
    const response = await fetch('http://127.0.0.1:3456/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(request)
    });

    if (!response.ok) {
      const error = await response.text();
      console.error(`${testName} failed:`, error);
      return;
    }

    const data = await response.json();
    console.log(`${testName} succeeded!`);
    
    if (data.choices && data.choices[0]) {
      const content = data.choices[0].message.content;
      console.log('Response:', content);
      
      // Try to parse as JSON if it looks like JSON
      if (content && (content.startsWith('{') || content.startsWith('['))) {
        try {
          const parsed = JSON.parse(content);
          console.log('Parsed JSON:', JSON.stringify(parsed, null, 2));
        } catch (e) {
          // Not valid JSON, that's okay
        }
      }
    }
    
    // Show usage info if prediction was used
    if (data.usage?.completion_tokens_details?.accepted_prediction_tokens) {
      console.log(`Prediction tokens accepted: ${data.usage.completion_tokens_details.accepted_prediction_tokens}`);
      console.log(`Prediction tokens rejected: ${data.usage.completion_tokens_details.rejected_prediction_tokens}`);
    }
  } catch (error) {
    console.error(`${testName} error:`, error.message);
  }
}

// Run tests
testResponseFormat();