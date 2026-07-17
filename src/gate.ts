import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type GateChoice = "continue" | "approve" | "quit" | "retry";

export async function askRoundGate(hasOpenBlockers: boolean): Promise<GateChoice> {
  const prompt = hasOpenBlockers
    ? "Open blockers remain. [c]ontinue / [a]pprove anyway / [q]uit: "
    : 'Consensus reached. [a]pprove / [c]ontinue another round / [q]uit: ';

  return askChoice(prompt, hasOpenBlockers ? ["c", "a", "q"] : ["a", "c", "q"]);
}

export async function askTimeoutGate(): Promise<GateChoice> {
  return askChoice("Agent timed out. [r]etry / [q]uit: ", ["r", "q"]);
}

async function askChoice(prompt: string, valid: string[]): Promise<GateChoice> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(prompt)).trim().toLowerCase();
      if (valid.includes(answer)) {
        return mapChoice(answer);
      }
      console.log(`Please enter one of: ${valid.join(", ")}`);
    }
  } finally {
    rl.close();
  }
}

function mapChoice(choice: string): GateChoice {
  switch (choice) {
    case "a":
      return "approve";
    case "c":
      return "continue";
    case "r":
      return "retry";
    default:
      return "quit";
  }
}
