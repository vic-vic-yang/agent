/**
 * 把文本中出现的密钥（如 access token）替换为 ***。
 * 用于 worker 的所有输出出口（日志行、结果 JSON），
 * 防止 git/命令报错信息把凭证泄露到任务详情页。
 */
export function redactSecrets(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) {
    if (!s || !s.trim()) continue;
    out = out.split(s).join("***");
  }
  return out;
}
