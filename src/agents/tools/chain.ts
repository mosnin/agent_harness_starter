/**
 * Tool chaining — compose multiple tools where each output feeds the next input.
 *
 * A ToolChain is itself a ToolDefinition, so it registers in the tool registry
 * and is callable by any agent that has permission to use it.
 *
 * Usage:
 *   const searchAndScrape = createToolChain("search_and_scrape")
 *     .description("Search the web, then scrape the top result.")
 *     .step(webSearchTool, (input) => ({ query: input.query }))
 *     .step(scraperTool,   (result, input) => ({ url: result.results[0].url }))
 *     .output((result) => result.content)
 *     .build();
 *
 *   registerTool(searchAndScrape);
 */

import { z } from "zod";
import type { ToolDefinition, ToolContext } from "./types";

export type ChainStepInputMapper<TPrev, TNext> = (
  previous: TPrev,
  originalInput: unknown,
  ctx: ToolContext
) => TNext | Promise<TNext>;

interface ChainStep {
  tool: ToolDefinition;
  mapInput: ChainStepInputMapper<unknown, unknown>;
}

export class ToolChainBuilder<TInput extends z.ZodTypeAny = z.ZodTypeAny> {
  private readonly chainSteps: ChainStep[] = [];
  private chainDescription = "";
  private chainParameters: TInput;
  private outputMapper: ((lastResult: unknown, ctx: ToolContext) => unknown) | undefined;

  constructor(
    private readonly chainName: string,
    parameters: TInput
  ) {
    this.chainParameters = parameters;
  }

  description(desc: string): this {
    this.chainDescription = desc;
    return this;
  }

  /**
   * Add a tool step to the chain.
   * `mapInput` receives the previous step's output and the original input;
   * return the input for this tool.
   */
  step<TPrev, TNext>(
    tool: ToolDefinition,
    mapInput: ChainStepInputMapper<TPrev, TNext>
  ): this {
    this.chainSteps.push({ tool, mapInput: mapInput as ChainStepInputMapper<unknown, unknown> });
    return this;
  }

  /**
   * Transform the last step's output into the chain's final output.
   * Default: return the last step's output as-is.
   */
  output(mapper: (lastResult: unknown, ctx: ToolContext) => unknown): this {
    this.outputMapper = mapper;
    return this;
  }

  build(): ToolDefinition<TInput, unknown> {
    const { chainName, chainDescription, chainSteps, chainParameters, outputMapper } = this;

    return {
      name: chainName,
      description: chainDescription || `Chain: ${chainSteps.map((s) => s.tool.name).join(" → ")}`,
      parameters: chainParameters,
      execute: async (input: z.infer<TInput>, ctx: ToolContext): Promise<unknown> => {
        if (chainSteps.length === 0) return input;

        let previousResult: unknown = input;

        for (let i = 0; i < chainSteps.length; i++) {
          const { tool, mapInput } = chainSteps[i];
          const toolInput = i === 0
            ? input
            : await Promise.resolve(mapInput(previousResult, input, ctx));
          previousResult = await tool.execute(toolInput, ctx);
        }

        return outputMapper ? outputMapper(previousResult, ctx) : previousResult;
      },
    };
  }
}

/**
 * Start building a tool chain.
 *
 * @param name - Registered tool name for the resulting chain
 * @param parameters - Zod schema for the chain's input (same as the first step's input)
 */
export function createToolChain<TInput extends z.ZodTypeAny>(
  name: string,
  parameters: TInput
): ToolChainBuilder<TInput> {
  return new ToolChainBuilder(name, parameters);
}
