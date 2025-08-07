import { Transformer } from "@/types/transformer";
import { UnifiedChatRequest } from "@/types/llm";
import { log } from "@/utils/log";

export class OpenAITransformer implements Transformer {
  name = "OpenAI";
  endPoint = "/v1/chat/completions";
  
  async transformRequestIn(request: UnifiedChatRequest): Promise<UnifiedChatRequest> {
    // OpenAI transformer passes through all fields including response_format and prediction
    // These fields are already part of UnifiedChatRequest and will be passed to the OpenAI API
    
    // Log if advanced features are being used
    if (request.response_format) {
      log(`OpenAI request using response_format: ${request.response_format.type}`);
    }
    
    if (request.prediction) {
      log(`OpenAI request using predicted outputs for model: ${request.model}`);
    }
    
    return request;
  }
}
