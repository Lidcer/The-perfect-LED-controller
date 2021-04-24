import { WebSocket } from "../socket/Websocket";
import { ControllerMode, RGB } from "../../../shared/interfaces";
import { MINUTE, MODES, SECOND } from "../../../shared/constants";
import { clamp, debounce } from "lodash";
import { AudioProcessor } from "../../../shared/audioProcessor";
import { AudioAnalyser } from "../../../shared/audioAnalyser";
import { AutoPilot } from "./AutoPilot";
import { Lights } from "./Devices/Controller";
import { saveSettings, settings } from "../main/storage";
import { sleep } from "../../../shared/utils";

export function setupLightHandler(websocket: WebSocket, light: Lights, audioProcessor: AudioProcessor) {
  const autoPilot = new AutoPilot(websocket);
  let doorFrameLoop: NodeJS.Timeout;
  const SERVER_FPS = SECOND * 0.05;

  let lightMode: ControllerMode = settings.controllerMode;
  let lastMode: ControllerMode = lightMode;
  let timeout: NodeJS.Timeout;
  const RGB: RGB = {
    r: 0,
    b: 0,
    g: 0,
  };
  const lastRGB: RGB = {
    r: 255,
    b: 255,
    g: 255,
  };
  const audioAnalyser = new AudioAnalyser(audioProcessor);

  const de = debounce(async () => {
    if(doorFrameLoop) {
      clearInterval(doorFrameLoop);
      doorFrameLoop = undefined;
    }

    let r = 255;
    let g = 255;
    let b = 255;

    doorFrameLoop = setInterval(() => {

      if (r > RGB.r) r--;
      if (g > RGB.g) g--;
      if (b > RGB.b) b--;
      
      if (r === RGB.r && b === RGB.b && b === RGB.b) {
        lightMode = lastMode;
        clearInterval(doorFrameLoop);
        doorFrameLoop = undefined;
      }
    
      light.setRGB(r, g, b);
      updateModeAndLight({r: RGB.r, g:RGB.g, b: RGB.b});
    }, 100)
  }, SECOND * 10)


  const setMode = async (mode: ControllerMode) => {
    switch (mode) {
      case "AutoPilot":
      case "Manual":
      case "Pattern":
      case "Audio":
      case "AudioRaw":
      case "ManualForce":
      case "ManualLocked":
        const diff = lightMode !== mode;
        lastMode = settings.controllerMode = lightMode = mode;
        websocket.broadcast("mode-update", lightMode);

      if (doorFrameLoop) {
        clearTimeout(doorFrameLoop);
        doorFrameLoop = undefined;
      }
      de.cancel();

        if (diff) {
          await saveSettings();
        }
        return;
      default:
        throw new Error(`Mode ${mode} does not exist!`);
    }
  };

  websocket.on<[number, number, number]>("rgb-set", (client, red, green, blue) => {
    client.validateAuthentication();
    if (client.clientType === 'client') {
      setMode("Manual");
    } else {
      setMode("AudioRaw");
    }
    RGB.r = clamp(red, 0, 255);
    RGB.b = clamp(blue, 0, 255);
    RGB.g = clamp(green, 0, 255);
  });

  websocket.onPromise<void, [ControllerMode]>("mode-set", async (client, mode) => {
    client.validateAuthentication();
    setMode(mode);
  });
  websocket.onPromise<ControllerMode, []>("mode-get", async client => {
    client.validateAuthentication();
    return lightMode;
  });

  websocket.onPromise<RGB, []>("rgb-status", async client => {
    client.validateAuthentication();
    return RGB;
  });

  websocket.onSocketEvent("all-clients-disconnected", () => {
    
    if (lightMode === "Manual" || lightMode === "ManualForce") {
      setMode("AutoPilot");
    }
  });

  const isStateChanged = () => {
    switch (lightMode) {
      case "Audio":
      case "AudioRaw":
        return true;
    }

    if(lightMode === "Door") {
      return false;
    }

    if (lightMode === "AutoPilot") {
      const { r, g, b } = autoPilot.scheduler.state;
      RGB.r = r;
      RGB.b = b;
      RGB.g = g;
    }

    const red = RGB.r === lastRGB.r;
    const blue = RGB.b === lastRGB.b;
    const green = RGB.g === lastRGB.g;
    return !(red && blue && green);
  };

  const changeState = async () => {
    if (lightMode === "Audio") {
      const { r, b, g } = audioAnalyser.getRGB();
      const value = light.setIfPossible(r, g, b);
      if (value) {
        RGB.r = lastRGB.r = r;
        RGB.g = lastRGB.g = g;
        RGB.b = lastRGB.b = b;
        websocket.broadcast("rgb-update", RGB);
      }
      return;
    }
    lastRGB.r = RGB.r;
    lastRGB.g = RGB.g;
    lastRGB.b = RGB.b;
    await light.setRGB(RGB.r, RGB.g, RGB.b);
    websocket.broadcast("rgb-update", RGB);
  };

  const tick = async () => {
    const now = Date.now();
    if (isStateChanged()) {
      await changeState();
    }

    const dateEnd = Date.now();
    const diff = dateEnd - now;
    if (diff > SERVER_FPS) {
      Logger.debug("Server is lagging!");
      timeout = setTimeout(tick, 0);
    } else {
      const next = lightMode === "Audio" || lightMode === "AudioRaw" ? 0 : SERVER_FPS - diff;
      timeout = setTimeout(tick, next);
    }
  };

  const updateModeAndLight = (rgb?:RGB) => {
    websocket.broadcast("mode-update", lightMode);
    websocket.broadcast("rgb-update", rgb || RGB);
  } 

  light.on('door', async (level) => {
    if (lightMode === "ManualLocked") {
      return;
    }

    if (doorFrameLoop) {
      clearTimeout(doorFrameLoop);
      doorFrameLoop = undefined;
    }

    if (level) {
      de.cancel();
      lightMode = 'Door';
      await light.setRGB(255, 255, 255);
    } else {
      de();
    }
    updateModeAndLight({r:255, g:255, b:255});
  })


  const destroy = () => {
    clearTimeout(timeout);
  };

  const onConnect = async () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = undefined;
    }
    await sleep(SECOND * 0.5);
    await light.setRGB(255, 0, 0);
    await sleep(SECOND * 0.5);
    await light.setRGB(0, 255, 0);
    await sleep(SECOND * 0.5);
    await light.setRGB(0, 0, 255);
    await sleep(SECOND * 0.5);
    await light.setRGB(0, 0, 0);
    await sleep(SECOND * 0.5);
    await light.setRGB(RGB.r, RGB.g, RGB.b);
    tick();
  };
  if (light.connected) {
    onConnect();
  }
  light.on('connect', () => {
    onConnect()
  })
  light.on('disconnect', () => {
    if (timeout) {
      clearTimeout(timeout)
      timeout = undefined;
    }
  })

  return { destroy };
}
