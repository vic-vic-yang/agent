import { query } from "@anthropic-ai/claude-agent-sdk";
import type { TaskMode } from "@agent-platform/shared";

// qa 为只读模式：禁掉所有能改文件或执行命令的工具（Bash 可绕过文件写限制、
// 也能读环境变量），只留 SDK 自带的只读检索工具（Read/Grep/Glob）。
export function disallowedToolsFor(mode: TaskMode): string[] {
  if (mode === "qa") return ["Write", "Edit", "NotebookEdit", "Bash"];
  return [];
}

const CODE_SYSTEM_PROMPT = `你是团队开发平台的编码 agent，在一个已克隆好的代码仓库中工作。
规则：
1. 先阅读相关代码、理解项目结构和惯例，再动手修改。
2. 只修改当前工作目录内的文件。
3. 如果仓库有与改动相关的测试，修改后运行它们并确保通过。
4. 不要执行任何 git commit/push/checkout 操作——版本控制由外层脚本处理。
5. 完成后用一段简明的中文总结你做了哪些改动、为什么。`;

const QA_SYSTEM_PROMPT = `你是团队开发平台的代码问答 agent，在一个只读的代码仓库中工作。
规则：
1. 只允许阅读和检索代码，禁止创建、修改、删除任何文件。
2. 回答要引用具体的文件路径和行为依据。
3. 用中文回答，使用 markdown 格式。`;

export async function runAgent(opts: {
  mode: TaskMode;
  prompt: string;
  cwd: string;
  log: (line: string) => void;
}): Promise<string> {
  const q = query({
    prompt: opts.prompt,
    options: {
      cwd: opts.cwd,
      permissionMode: "bypassPermissions",
      systemPrompt: opts.mode === "code" ? CODE_SYSTEM_PROMPT : QA_SYSTEM_PROMPT,
      ...(process.env.MODEL ? { model: process.env.MODEL } : {}),
      disallowedTools: disallowedToolsFor(opts.mode)
    }
  });

  let final = "";
  for await (const msg of q) {
    if (msg.type === "assistant") {
      for (const block of msg.message.content) {
        if (block.type === "text" && block.text.trim()) {
          for (const line of block.text.split("\n")) if (line.trim()) opts.log(line);
        } else if (block.type === "tool_use") {
          opts.log(`[工具] ${block.name}`);
        }
      }
    } else if (msg.type === "result") {
      if (msg.subtype === "success") {
        final = msg.result;
      } else {
        throw new Error(`agent 执行失败: ${msg.subtype}`);
      }
    }
  }
  return final;
}
