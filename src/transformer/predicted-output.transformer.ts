import { UnifiedChatRequest, PredictionContent } from "../types/llm";
import { Transformer, TransformerOptions } from "../types/transformer";
import { log } from "../utils/log";

// Models that support predicted outputs feature
const PREDICTED_OUTPUT_MODELS = [
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-4o-2024-08-06",
  "gpt-4o-2024-11-20",
  "gpt-4o-mini-2024-07-18"
];

export class PredictedOutputTransformer implements Transformer {
  name = "predicted-output";
  
  constructor(private options?: TransformerOptions) {}

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    // If prediction is already set or not configured in options, pass through
    if (request.prediction || !this.options?.enablePrediction) {
      return request;
    }

    // Check if model supports predicted outputs
    const supportsPrediction = PREDICTED_OUTPUT_MODELS.some(model => 
      request.model.includes(model)
    );

    if (!supportsPrediction) {
      log(`Model ${request.model} does not support predicted outputs. Skipping prediction.`);
      return request;
    }

    // Auto-detect prediction scenarios
    const prediction = this.detectPredictionContent(request);
    
    if (prediction) {
      log(`Auto-detected prediction content for model ${request.model}`);
      request.prediction = prediction;
    }

    return request;
  }

  private detectPredictionContent(request: UnifiedChatRequest): PredictionContent | null {
    // Look for patterns that suggest prediction would be helpful
    const messages = request.messages;
    
    if (messages.length < 2) {
      return null;
    }

    const lastMessage = messages[messages.length - 1];
    const secondLastMessage = messages[messages.length - 2];

    // Pattern 1: Edit/Update requests with code or document content
    if (this.isEditRequest(lastMessage)) {
      // Look for code or document content in previous messages
      const content = this.extractContentForPrediction(messages);
      if (content) {
        return {
          type: "content",
          content: content
        };
      }
    }

    // Pattern 2: Refactor/Rewrite with existing content
    if (this.isRefactorRequest(lastMessage)) {
      const content = this.extractContentForPrediction(messages);
      if (content) {
        return {
          type: "content",
          content: content
        };
      }
    }

    // Pattern 3: Fix errors in code (with original code available)
    if (this.isFixRequest(lastMessage)) {
      const content = this.extractCodeContent(messages);
      if (content) {
        return {
          type: "content",
          content: content
        };
      }
    }

    return null;
  }

  private isEditRequest(message: any): boolean {
    if (typeof message.content === "string") {
      const editKeywords = [
        "edit", "update", "modify", "change", "replace",
        "alter", "revise", "adjust", "amend"
      ];
      const content = message.content.toLowerCase();
      return editKeywords.some(keyword => content.includes(keyword));
    }
    return false;
  }

  private isRefactorRequest(message: any): boolean {
    if (typeof message.content === "string") {
      const refactorKeywords = [
        "refactor", "rewrite", "restructure", "reorganize",
        "optimize", "improve", "clean up", "simplify"
      ];
      const content = message.content.toLowerCase();
      return refactorKeywords.some(keyword => content.includes(keyword));
    }
    return false;
  }

  private isFixRequest(message: any): boolean {
    if (typeof message.content === "string") {
      const fixKeywords = [
        "fix", "correct", "repair", "debug", "solve",
        "resolve", "patch", "error", "bug"
      ];
      const content = message.content.toLowerCase();
      return fixKeywords.some(keyword => content.includes(keyword));
    }
    return false;
  }

  private extractContentForPrediction(messages: any[]): string | null {
    // Look for code blocks or large text content in messages
    for (let i = messages.length - 2; i >= 0; i--) {
      const message = messages[i];
      
      if (typeof message.content === "string") {
        // Check for code blocks
        const codeBlockMatch = message.content.match(/```[\s\S]+?```/);
        if (codeBlockMatch) {
          return codeBlockMatch[0].replace(/```\w*\n?|```$/g, '').trim();
        }

        // Check for substantial text content (more than 200 chars)
        if (message.content.length > 200) {
          return message.content;
        }
      } else if (Array.isArray(message.content)) {
        // Check array content for text
        for (const item of message.content) {
          if (item.type === "text" && item.text) {
            const codeBlockMatch = item.text.match(/```[\s\S]+?```/);
            if (codeBlockMatch) {
              return codeBlockMatch[0].replace(/```\w*\n?|```$/g, '').trim();
            }
            if (item.text.length > 200) {
              return item.text;
            }
          }
        }
      }
    }

    return null;
  }

  private extractCodeContent(messages: any[]): string | null {
    // Specifically look for code content
    for (let i = messages.length - 2; i >= 0; i--) {
      const message = messages[i];
      
      if (typeof message.content === "string") {
        // Check for code blocks with language identifiers
        const codeBlockMatch = message.content.match(/```(?:javascript|typescript|python|java|cpp|c|go|rust|ruby|php|swift|kotlin|scala|r|matlab|sql|html|css|jsx|tsx|json|xml|yaml|toml|ini|conf|sh|bash|powershell|dockerfile|makefile)[\s\S]+?```/i);
        if (codeBlockMatch) {
          return codeBlockMatch[0].replace(/```\w*\n?|```$/g, '').trim();
        }

        // Check for generic code blocks
        const genericCodeMatch = message.content.match(/```[\s\S]+?```/);
        if (genericCodeMatch) {
          const content = genericCodeMatch[0].replace(/```\w*\n?|```$/g, '').trim();
          // Simple heuristic to check if it's likely code
          if (this.looksLikeCode(content)) {
            return content;
          }
        }
      }
    }

    return null;
  }

  private looksLikeCode(content: string): boolean {
    // Simple heuristics to detect code
    const codeIndicators = [
      /function\s+\w+\s*\(/,  // function declarations
      /const\s+\w+\s*=/,       // const declarations
      /let\s+\w+\s*=/,         // let declarations
      /var\s+\w+\s*=/,         // var declarations
      /class\s+\w+/,           // class declarations
      /if\s*\([^)]+\)\s*{/,    // if statements
      /for\s*\([^)]+\)\s*{/,   // for loops
      /while\s*\([^)]+\)\s*{/, // while loops
      /=>\s*{/,                // arrow functions
      /import\s+.+from/,       // imports
      /export\s+/,             // exports
      /def\s+\w+\s*\(/,        // Python functions
      /public\s+class/,        // Java classes
      /#include\s*</,          // C/C++ includes
    ];

    return codeIndicators.some(pattern => pattern.test(content));
  }
}

// Explicit Predicted Output Transformer for manual control
export class ExplicitPredictedOutputTransformer implements Transformer {
  name = "explicit-predicted-output";
  
  constructor(private options?: TransformerOptions) {}

  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    // This transformer expects prediction to be explicitly set in the request
    // or provided via options
    
    if (!request.prediction && this.options?.prediction) {
      // Check model compatibility
      const supportsPrediction = PREDICTED_OUTPUT_MODELS.some(model => 
        request.model.includes(model)
      );

      if (!supportsPrediction) {
        throw new Error(
          `Model ${request.model} does not support predicted outputs. ` +
          `Supported models: ${PREDICTED_OUTPUT_MODELS.join(", ")}`
        );
      }

      // Set prediction from options
      request.prediction = {
        type: "content",
        content: this.options.prediction
      };

      log(`Added explicit prediction content for model ${request.model}`);
    }

    // Validate model if prediction is set
    if (request.prediction) {
      const supportsPrediction = PREDICTED_OUTPUT_MODELS.some(model => 
        request.model.includes(model)
      );

      if (!supportsPrediction) {
        log(`Warning: Model ${request.model} does not support predicted outputs. Removing prediction.`);
        delete request.prediction;
      }
    }

    return request;
  }
}