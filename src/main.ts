import { runServer } from "./server.ts";
import {
  cmdLs, cmdAdd, cmdRm, cmdDoctor, cmdHelp,
  cmdStart, cmdStop, cmdRestart, cmdStatus,
} from "./cli.ts";

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case undefined:
  case "help":
  case "-h":
  case "--help":
    cmdHelp();
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
    cmdRm(rest[0]);
    break;
  case "doctor":
    await cmdDoctor();
    break;
  default:
    console.error(`unknown command: ${cmd}\n`);
    cmdHelp();
    process.exit(2);
}
