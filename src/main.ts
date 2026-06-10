import { runServer } from "./server.ts";
import { VERSION } from "./config.ts";
import {
  cmdLs, cmdAdd, cmdRm, cmdDoctor, cmdHelp,
  cmdStart, cmdStop, cmdRestart, cmdStatus, cmdDiarize, cmdLog, cmdLimit, cmdReload,
} from "./cli.ts";

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case undefined:
  case "help":
  case "-h":
  case "--help":
    cmdHelp();
    break;
  case "version":
  case "-v":
  case "--version":
    console.log(`voiced ${VERSION}`);
    break;
  case "serve":
    await runServer();
    break;
  case "start":
    cmdStart();
    break;
  case "stop":
    cmdStop();
    break;
  case "restart":
    cmdRestart();
    break;
  case "status":
    await cmdStatus();
    break;
  case "ls":
    cmdLs();
    break;
  case "add":
    if (!rest[0]) { console.error("usage: voiced add <name>"); process.exit(2); }
    await cmdAdd(rest[0]);
    break;
  case "rm":
    if (!rest[0]) { console.error("usage: voiced rm <name>"); process.exit(2); }
    await cmdRm(rest[0]);
    break;
  case "limit":
    await cmdLimit(rest);
    break;
  case "reload":
    await cmdReload();
    break;
  case "diarize":
    await cmdDiarize(rest);
    break;
  case "log":
    await cmdLog(rest);
    break;
  case "doctor":
    await cmdDoctor();
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(2);
}
