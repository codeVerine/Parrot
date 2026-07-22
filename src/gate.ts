import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export type GateChoice = "continue" | "approve" | "quit" | "retry";
export type RoundGateChoice =
  | { action: "continue" | "approve" | "quit" }
  | { action: "message"; message: string };

export async function askRoundGate(openObjectionCount: number): Promise<RoundGateChoice> {
  const hasOpenObjections = openObjectionCount > 0;
  const prompt = hasOpenObjections
    ? "Iteration cap reached with open objections. [c]ontinue one more round / [m]essage planner and continue / [a]pprove anyway / [q]uit: "
    : "Consensus reached. [a]pprove / [c]ontinue another round / [m]essage planner / [q]uit: ";

  return askRoundChoice(prompt, hasOpenObjections ? ["c", "m", "a", "q"] : ["a", "c", "m", "q"]);
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

async function askRoundChoice(prompt: string, valid: string[]): Promise<RoundGateChoice> {
  const rl = createInterface({ input, output });
  try {
    while (true) {
      const answer = (await rl.question(prompt)).trim().toLowerCase();
      if (!valid.includes(answer)) {
        console.log(`Please enter one of: ${valid.join(", ")}`);
        continue;
      }

      if (answer !== "m") {
        return { action: mapChoice(answer) as "continue" | "approve" | "quit" };
      }

      const message = (await rl.question("Message for planner: ")).trim();
      if (message.length > 0) {
        return { action: "message", message };
      }
      console.log("Please enter a non-empty message.");
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
