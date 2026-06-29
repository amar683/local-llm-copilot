import * as vscode from 'vscode';
import { executeToolCall, ToolResult } from './toolExecutor';

export interface AgentStep {
  id: string;
  description: string;
  status: 'pending' | 'in-progress' | 'completed' | 'failed' | 'skipped';
  result?: string;
}

export interface AgentPlan {
  goal: string;
  steps: AgentStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'paused' | 'completed' | 'failed';
}

export interface AgentMemory {
  goal: string;
  plan: AgentPlan | null;
  scratchpad: string;
}

export type StreamCompletionFn = (messages: any[], collectToolCalls: boolean) => Promise<{ content: string; toolCalls: any[] } | null>;
export type ToolCallCallbackFn = (toolName: string, toolArgs: any, callId: string, result: ToolResult) => void;
export type PlanUpdateCallbackFn = (plan: AgentPlan) => void;
export type StatusChangeCallbackFn = (status: string, message?: string) => void;
export type ToolCallStartFn = (toolName: string, toolArgs: any, callId: string) => void;

export class AgentController {
  private memory: AgentMemory = {
    goal: '',
    plan: null,
    scratchpad: ''
  };
  
  private maxIterations = 50;
  private abortRequested = false;
  private isPaused = false;
  private isDone = false;

  constructor() {}

  public getMemory(): AgentMemory {
    return this.memory;
  }

  public abort() {
    this.abortRequested = true;
  }

  public pause() {
    this.isPaused = true;
  }

  public resume() {
    this.isPaused = false;
  }

  public async runAgentTask(
    goal: string,
    initialMessages: any[],
    streamCompletion: StreamCompletionFn,
    onToolCallStart: ToolCallStartFn,
    onToolCallResult: ToolCallCallbackFn,
    onPlanUpdate: PlanUpdateCallbackFn,
    onStatusChange: StatusChangeCallbackFn
  ): Promise<void> {
    this.memory.goal = goal;
    this.memory.plan = null;
    this.memory.scratchpad = '';
    this.abortRequested = false;
    this.isPaused = false;
    this.isDone = false;

    let iteration = 0;
    let messages = [...initialMessages];
    
    // Inject goal as user message if it's not already in context
    if (messages.length === 0 || messages[messages.length - 1].role !== 'user') {
        messages.push({ role: 'user', content: `Goal: ${goal}` });
    }

    onStatusChange('planning', 'Analyzing goal and formulating a plan...');

    while (iteration < this.maxIterations && !this.abortRequested && !this.isDone) {
      if (this.isPaused) {
        onStatusChange('paused', 'Agent paused');
        // Wait for resume or abort
        await new Promise(resolve => {
          const interval = setInterval(() => {
            if (!this.isPaused || this.abortRequested) {
              clearInterval(interval);
              resolve(true);
            }
          }, 500);
        });
        if (this.abortRequested) break;
        onStatusChange('executing', 'Agent resumed');
      }

      iteration++;
      
      const result = await streamCompletion(messages, true);
      if (!result) break; // Error or stream aborted

      if (result.toolCalls && result.toolCalls.length > 0) {
        const assistantMsg: any = { role: 'assistant', content: result.content || null };
        assistantMsg.tool_calls = result.toolCalls.map((tc: any) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.function.name,
            arguments: tc.function.arguments
          }
        }));
        messages.push(assistantMsg);

        for (const toolCall of result.toolCalls) {
          if (this.abortRequested) break;

          const funcName = toolCall.function.name;
          let funcArgs: Record<string, any> = {};
          try {
            funcArgs = JSON.parse(toolCall.function.arguments);
          } catch {
            funcArgs = {};
          }

          onToolCallStart(funcName, funcArgs, toolCall.id);

          // Handle agent-specific tools natively
          let toolResult: ToolResult;
          
          if (funcName.startsWith('agent_')) {
            toolResult = this.handleAgentTool(funcName, funcArgs);
            if (funcName === 'agent_plan' || funcName === 'agent_update_step') {
              if (this.memory.plan) {
                onPlanUpdate(this.memory.plan);
              }
            }
          } else {
            // Forward to standard tool executor
            toolResult = await executeToolCall(funcName, funcArgs);
          }

          onToolCallResult(funcName, funcArgs, toolCall.id, toolResult);

          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: toolResult.output
          });
        }
      } else {
        // No tools called, just conversation
        messages.push({
          role: 'assistant',
          content: result.content
        });
        // Often we want to prompt the agent to continue or finish if it stopped without calling a tool in agent mode
        if (!this.isDone) {
            messages.push({
                role: 'user',
                content: 'Please continue working towards the goal, or use agent_done if you are finished.'
            });
        } else {
            break;
        }
      }
    }

    if (iteration >= this.maxIterations) {
      onStatusChange('failed', 'Reached maximum iterations limit.');
    } else if (this.abortRequested) {
      onStatusChange('failed', 'Task aborted by user.');
    } else if (this.isDone) {
      onStatusChange('completed', 'Task completed.');
    }
  }

  private handleAgentTool(toolName: string, args: Record<string, any>): ToolResult {
    try {
      switch (toolName) {
        case 'agent_plan':
          return this.handlePlanTool(args);
        case 'agent_update_step':
          return this.handleUpdateStepTool(args);
        case 'agent_scratchpad':
          return this.handleScratchpadTool(args);
        case 'agent_done':
          return this.handleDoneTool(args);
        default:
          return { success: false, output: `Unknown agent tool: ${toolName}` };
      }
    } catch (err: any) {
      return { success: false, output: `Error in ${toolName}: ${err.message}` };
    }
  }

  private handlePlanTool(args: Record<string, any>): ToolResult {
    if (!args.steps || !Array.isArray(args.steps)) {
      return { success: false, output: 'Missing or invalid "steps" array in agent_plan call.' };
    }
    
    const steps: AgentStep[] = args.steps.map((s: any, idx: number) => ({
      id: s.id || `step-${idx}`,
      description: s.description || 'Unknown step',
      status: s.status || 'pending',
      result: s.result
    }));

    this.memory.plan = {
      goal: this.memory.goal,
      steps,
      currentStepIndex: args.currentStepIndex || 0,
      status: 'executing'
    };

    return { success: true, output: 'Plan updated successfully.' };
  }

  private handleUpdateStepTool(args: Record<string, any>): ToolResult {
    if (!this.memory.plan) {
      return { success: false, output: 'No active plan. Call agent_plan first.' };
    }
    
    const { stepId, status, result } = args;
    const step = this.memory.plan.steps.find(s => s.id === stepId);
    if (!step) {
      return { success: false, output: `Step ID ${stepId} not found in current plan.` };
    }

    if (status) step.status = status;
    if (result !== undefined) step.result = result;

    return { success: true, output: `Step ${stepId} updated to ${status}.` };
  }

  private handleScratchpadTool(args: Record<string, any>): ToolResult {
    const { action, text } = args;
    
    if (action === 'append') {
      this.memory.scratchpad += '\n' + (text || '');
    } else if (action === 'replace') {
      this.memory.scratchpad = text || '';
    } else if (action === 'clear') {
      this.memory.scratchpad = '';
    } else {
      return { success: false, output: 'Invalid action. Use append, replace, or clear.' };
    }

    return { success: true, output: 'Scratchpad updated.' };
  }

  private handleDoneTool(args: Record<string, any>): ToolResult {
    this.isDone = true;
    if (this.memory.plan) {
        this.memory.plan.status = args.success ? 'completed' : 'failed';
    }
    return { success: true, output: 'Task marked as done.' };
  }
}
