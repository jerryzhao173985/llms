/**
 * OpenAI Responses API Type Definitions
 * Complete type system for the Responses API V2 transformer
 */

// ============================================
// Request Types
// ============================================

export interface ResponsesApiRequest {
  model: string;
  input: ResponsesApiMessage[] | string;
  system?: ResponsesApiSystemContent;
  tools?: ResponsesApiTool[];
  tool_choice?: 'auto' | 'none' | 'required' | { type: 'function'; function: { name: string } };
  max_output_tokens: number;
  temperature?: number;
  top_p?: number;
  stream?: boolean;
  reasoning?: ResponsesApiReasoning;
  response_format?: ResponsesApiResponseFormat;
  previous_response_id?: string;
  store?: boolean;
  background?: boolean;
  parallel_tool_calls?: boolean;
}

export interface ResponsesApiMessage {
  role: 'user' | 'assistant' | 'system';
  content: ResponsesApiContent[];
}

// Note: ToolResultContent is not supported by OpenAI Responses API
// Tool results must be sent as InputTextContent with structured text
export type ResponsesApiContent = 
  | InputTextContent
  | OutputTextContent
  | InputImageContent
  | OutputImageContent
  | ToolUseContent;

export interface InputTextContent {
  type: 'input_text';
  text: string;
}

export interface OutputTextContent {
  type: 'output_text';
  text: string;
  annotations?: any[];
}

export interface InputImageContent {
  type: 'input_image';
  image_url: string;
}

export interface OutputImageContent {
  type: 'output_image';
  image_url: string;
}

// Internal type for processing - not supported by Responses API
// Tool results are converted to InputTextContent during transformation
export interface ToolResultContent {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

export interface ToolUseContent {
  type: 'tool_use';
  id: string;
  name: string;
  input: any;
}

export type ResponsesApiSystemContent = string | ResponsesApiContent[];

export interface ResponsesApiTool {
  type: 'function';
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, any>;
    required?: string[];
    additionalProperties?: boolean;
    strict?: boolean;
  };
}

export interface ResponsesApiReasoning {
  effort: 'low' | 'medium' | 'high';
  summary?: 'auto' | 'disabled' | 'detailed';
  encrypted_content?: string;
}

export interface ResponsesApiResponseFormat {
  type: 'text' | 'json_object' | 'json_schema';
  json_schema?: {
    name: string;
    description?: string;
    schema: any;
    strict?: boolean;
  };
}

// ============================================
// Response Types
// ============================================

export interface ResponsesApiResponse {
  id: string;
  object: 'response';
  created_at: number;
  model: string;
  status: 'completed' | 'incomplete' | 'failed';
  output: ResponsesApiOutput[];
  usage: ResponsesApiUsage;
  reasoning?: {
    effort: string;
    summary?: string;
    encrypted_content?: string;
  };
  response_id?: string;
  previous_response_id?: string;
  store?: boolean;
  background?: boolean;
  error?: ResponsesApiError;
  incomplete_details?: {
    reason: string;
  };
}

export type ResponsesApiOutput = 
  | MessageOutput
  | FunctionCallOutput
  | ReasoningOutput;

export interface MessageOutput {
  id: string;
  type: 'message';
  role: 'assistant';
  content: ResponsesApiContent[];
  status?: 'completed' | 'incomplete';
}

export interface FunctionCallOutput {
  id: string;
  type: 'function_call';
  name: string;
  arguments: string;
  call_id: string;
  status: 'completed' | 'failed';
}

export interface ReasoningOutput {
  id: string;
  type: 'reasoning';
  summary: string[];
}

export interface ResponsesApiUsage {
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  input_tokens_details?: {
    cached_tokens: number;
  };
  output_tokens_details?: {
    reasoning_tokens: number;
  };
}

export interface ResponsesApiError {
  message: string;
  type: string;
  code?: string;
}

// ============================================
// Streaming Types
// ============================================

export interface ResponsesApiStreamEvent {
  type: string;
  data?: any;
  item?: any;
  delta?: any;
  response?: any;
  response_id?: string;
  sequence_number?: number;
}

export type StreamEventType = 
  | 'response.created'
  | 'response.output_item.added'
  | 'response.output_text.delta'
  | 'response.text.delta'
  | 'response.output_item.done'
  | 'response.function_call.added'
  | 'response.function_call.delta'
  | 'response.function_call.done'
  | 'response.reasoning.delta'
  | 'response.reasoning.done'
  | 'response.completed'
  | 'response.incomplete';

export interface TextDeltaEvent {
  type: 'response.output_text.delta' | 'response.text.delta';
  delta: string;
  item_id?: string;
}

export interface FunctionCallAddedEvent {
  type: 'response.function_call.added';
  item: {
    id: string;
    type: 'function_call';
    name: string;
    call_id: string;
  };
}

export interface FunctionCallDeltaEvent {
  type: 'response.function_call.delta';
  delta: {
    arguments: string;
  };
  item_id: string;
  call_id: string;
}

export interface FunctionCallDoneEvent {
  type: 'response.function_call.done';
  item: FunctionCallOutput;
}

// ============================================
// Transformer State Types
// ============================================

export interface ConversationState {
  response_id: string;
  previous_response_id?: string;
  reasoning_context?: string;
  tool_history: ToolCallHistory[];
  cache_keys: string[];
  created_at: number;
  updated_at: number;
}

export interface ToolCallHistory {
  call_id: string;
  tool_name: string;
  arguments: string;
  result?: string;
  timestamp: number;
  status: 'pending' | 'completed' | 'failed';
}

export interface StreamState {
  buffer: string;
  currentToolCall?: {
    id: string;
    name: string;
    arguments: string;
  };
  pendingText: string[];
  responseId?: string;
  sequenceNumber: number;
  hasContent: boolean;
  hadToolCalls?: boolean;
  contentLength?: number;
  shouldContinue?: boolean;
}

// ============================================
// Transformer Options
// ============================================

export interface ResponsesApiV2Options {
  // Stateful conversation support
  enableStateful?: boolean;
  preserveReasoning?: boolean;
  
  // Token management
  tokenMultiplier?: number;
  minTokensForTools?: number;
  maxTokensLimit?: number;
  
  // Streaming configuration
  streamBufferSize?: number;
  streamTimeout?: number;
  
  // Retry policy
  maxRetries?: number;
  retryDelay?: number;
  exponentialBackoff?: boolean;
  
  // Background mode
  backgroundTimeout?: number;
  pollInterval?: number;
  
  // Debug options
  verboseLogging?: boolean;
  logLevel?: 'error' | 'warn' | 'info' | 'debug';
  
  // Fallback behavior
  fallbackEnabled?: boolean;
  fallbackThreshold?: number;
  
  // Continuous execution control
  continuousExecution?: boolean;  // Enable aggressive continuation (default: true)
  alwaysContinueWithTools?: boolean;  // Never stop when tools are called (default: true)
}

// ============================================
// Helper Types
// ============================================

export interface TokenCalculation {
  base: number;
  toolOverhead: number;
  reasoningOverhead: number;
  historyOverhead: number;
  total: number;
  cappedAt?: number;
}

export interface TransformationResult<T> {
  success: boolean;
  data?: T;
  error?: string;
  warnings?: string[];
}

export interface ToolTransformationContext {
  toolCallMap: Map<string, ToolCallHistory>;
  pendingToolCalls: any[];
  orphanedResults: any[];
}