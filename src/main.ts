import { runServer } from "./server.ts";
import { cmdLs, cmdAdd, cmdRm, cmdDoctor, cmdHelp } from "./cli.ts";

const [, , cmd, ...rest] = process.argv;

switch (cmd) {
  case undefined:
    await runServer();
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
  case "help":
  case "-h":
  case "--help":
    cmdHelp();
    break;
  default:
    console.error(`unknown command: ${cmd}`);
    cmdHelp();
    process.exit(2);
}
