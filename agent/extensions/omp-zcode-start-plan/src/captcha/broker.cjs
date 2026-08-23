const { app, BrowserWindow } = require("electron");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const HTML_PATH = path.join(__dirname, "index.html");
const LOGO = readFileSync(path.join(__dirname, "logo.txt"), "utf8").trim();
const INTERACTIVE_MARKER = "__ZCODE_CAPTCHA_INTERACTIVE__";
const SDK_URL = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
let window = null;
let queue = Promise.resolve();
let quitting = false;

function zcodeUserAgent(appVersion) {
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) ZCode/${appVersion} Chrome/146.0.7680.80 Electron/41.0.3 Safari/537.36`;
}

async function ensureWindow(appVersion) {
  if (!window || window.isDestroyed()) {
    window = new BrowserWindow({
      show: false,
      width: 990,
      height: 640,
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    window.on("close", (event) => {
      if (quitting) return;
      event.preventDefault();
      window.hide();
    });
    window.webContents.on("console-message", (...args) => {
      const message = args.find((value) => typeof value === "string" && value.includes(INTERACTIVE_MARKER));
      if (message && window && !window.isDestroyed()) window.show();
    });
  }
  window.webContents.setUserAgent(zcodeUserAgent(appVersion));
  await window.loadFile(HTML_PATH);
  return window;
}

function buildSolveScript(request) {
  const config = JSON.stringify(request.config);
  const logo = JSON.stringify(LOGO);
  const sdkUrl = JSON.stringify(SDK_URL);
  const marker = JSON.stringify(INTERACTIVE_MARKER);
  return `
    (async () => {
      const config = ${config};
      const sleep = (ms) => {
        const result = Promise.withResolvers();
        setTimeout(result.resolve, ms);
        return result.promise;
      };
      window.AliyunCaptchaConfig = { region: config.region, prefix: config.prefix };
      const sdkLoad = Promise.withResolvers();
      const script = document.createElement("script");
      script.src = ${sdkUrl};
      script.onload = sdkLoad.resolve;
      script.onerror = () => sdkLoad.reject(new Error("Aliyun CAPTCHA SDK load failed"));
      document.head.appendChild(script);
      await sdkLoad.promise;
      for (let i = 0; i < 100 && typeof window.initAliyunCaptcha !== "function"; i += 1) {
        await sleep(100);
      }
      if (typeof window.initAliyunCaptcha !== "function") {
        return { ok: false, error: "Aliyun CAPTCHA SDK did not initialize" };
      }
      const verification = Promise.withResolvers();
      let instance;
      let interactiveStarted = false;
      window.initAliyunCaptcha({
        SceneId: config.sceneId,
        mode: "popup",
        region: config.region,
        language: "en",
        captchaLogoImg: ${logo},
        showErrorTip: false,
        element: "#zcode-aliyun-captcha-element",
        button: "#zcode-aliyun-captcha-button",
        getInstance: (value) => {
          instance = value;
          try {
            instance.startTracelessVerification();
          } catch (error) {
            verification.resolve({ ok: false, error: String(error) });
          }
        },
        success: (verifyParam) => verification.resolve({ ok: true, verifyParam }),
        fail: (detail) => {
          if (!interactiveStarted && instance && typeof instance.show === "function") {
            interactiveStarted = true;
            console.log(${marker});
            try {
              instance.show();
              return;
            } catch (error) {
              verification.resolve({ ok: false, error: String(error) });
              return;
            }
          }
          verification.resolve({ ok: false, error: "Aliyun CAPTCHA verification failed" });
        },
        onError: () => verification.resolve({ ok: false, error: "Aliyun CAPTCHA SDK error" }),
      });
      const timeout = Promise.withResolvers();
      const timeoutId = setTimeout(
        () => timeout.resolve({ ok: false, error: "Aliyun CAPTCHA verification timed out" }),
        80_000,
      );
      const result = await Promise.race([verification.promise, timeout.promise]);
      clearTimeout(timeoutId);
      return result;
    })()
  `;
}

async function solve(request) {
  const target = await ensureWindow(request.appVersion);
  const result = await target.webContents.executeJavaScript(buildSolveScript(request), true);
  target.hide();
  if (!result || result.ok !== true || typeof result.verifyParam !== "string" || !result.verifyParam) {
    throw new Error(result && typeof result.error === "string" ? result.error : "Electron CAPTCHA solve failed");
  }
  return result.verifyParam;
}

function send(response) {
  process.stdout.write(`${JSON.stringify(response)}\n`);
}

function isRequest(value) {
  return value && typeof value === "object" && Number.isInteger(value.id)
    && typeof value.appVersion === "string" && value.config && typeof value.config === "object"
    && typeof value.config.sceneId === "string" && typeof value.config.region === "string"
    && typeof value.config.prefix === "string";
}

app.on("before-quit", () => {
  quitting = true;
});

app.whenReady().then(() => {
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  input.on("line", (line) => {
    queue = queue.then(async () => {
      let request;
      try {
        request = JSON.parse(line);
        if (!isRequest(request)) throw new Error("Invalid CAPTCHA broker request");
        const verifyParam = await solve(request);
        send({ id: request.id, ok: true, verifyParam });
      } catch (error) {
        send({
          id: request && Number.isInteger(request.id) ? request.id : -1,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    });
  });
  input.on("close", () => app.quit());
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  app.exit(1);
});
