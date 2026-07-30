import { lstat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { BashCommandUnit } from "./bash";

const ONE_TOKEN_COMMANDS: Record<string, true> = {
  cat: true, cd: true, chmod: true, chown: true, cp: true, echo: true, env: true, export: true, grep: true,
  kill: true, killall: true, ln: true, ls: true, mkdir: true, mv: true, ps: true, pwd: true, rm: true,
  rmdir: true, sleep: true, source: true, tail: true, touch: true, unset: true, which: true,
};

const THREE_TOKEN_COMMANDS: Record<string, true> = {
  aws: true, az: true, doctl: true, gcloud: true, gh: true, sfdx: true,
};

const THREE_TOKEN_PREFIXES: Record<string, true> = {
  "bun run": true, "bun x": true, "cargo add": true, "cargo run": true, "consul kv": true,
  "docker builder": true, "docker compose": true, "docker container": true, "docker image": true,
  "docker network": true, "docker volume": true, "eksctl create": true, "git config": true,
  "git remote": true, "git stash": true, "ip addr": true, "ip link": true, "ip netns": true,
  "ip route": true, "mc admin": true, "npm exec": true, "npm init": true, "npm run": true,
  "npm view": true, "openssl req": true, "openssl x509": true, "pnpm dlx": true, "pnpm exec": true,
  "pnpm run": true, "podman container": true, "podman image": true, "pulumi stack": true,
  "terraform workspace": true, "vault auth": true, "vault kv": true, "yarn dlx": true, "yarn run": true,
};

const TWO_TOKEN_COMMANDS: Record<string, true> = {
  bazel: true, brew: true, bun: true, cargo: true, cdk: true, cf: true, cmake: true, composer: true,
  consul: true, crictl: true, deno: true, docker: true, eksctl: true, firebase: true, flyctl: true, git: true,
  go: true, gradle: true, helm: true, heroku: true, hugo: true, ip: true, kind: true, kubectl: true,
  kustomize: true, make: true, mc: true, minikube: true, mongosh: true, mysql: true, mvn: true, ng: true,
  npm: true, nvm: true, nx: true, openssl: true, pip: true, pipenv: true, pnpm: true, poetry: true,
  podman: true, psql: true, pulumi: true, pyenv: true, python: true, rake: true, rbenv: true,
  "redis-cli": true, rustup: true, serverless: true, skaffold: true, sls: true, sst: true, swift: true,
  systemctl: true, terraform: true, tmux: true, turbo: true, ufw: true, vault: true, vercel: true,
  volta: true, wp: true, yarn: true,
};

/** OpenCode-style human command prefix used for session-wide shell grants. */
export function bashAlwaysPattern(command: BashCommandUnit): string {
  const executable = command.executable;
  if (!executable) return command.text;
  const tokens = [executable, ...command.arguments];
  const firstTwo = tokens.slice(0, 2).join(" ");
  const arity = THREE_TOKEN_PREFIXES[firstTwo]
    ? 3
    : ONE_TOKEN_COMMANDS[executable]
      ? 1
      : THREE_TOKEN_COMMANDS[executable]
        ? 3
        : TWO_TOKEN_COMMANDS[executable]
          ? 2
          : 1;
  return `${tokens.slice(0, Math.min(arity, tokens.length)).join(" ")} *`;
}

/** Match OpenCode's external-directory scope: the containing directory plus `*`. */
export async function externalAlwaysPattern(canonical: string): Promise<string> {
  const directory = await lstat(canonical)
    .then((info) => info.isDirectory() ? canonical : dirname(canonical))
    .catch(() => dirname(canonical));
  return join(directory, "*").replaceAll("\\", "/");
}
