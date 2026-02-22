import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { WarRoomCard, CardType, CardStatus, CardColumn } from "../types.js";
import { generateId, now, Logger } from "../../shared/utils.js";
import { warRoomCards } from "../workspace.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const log = new Logger("WarRoom");

/** Register War Room tools: upsert_card, execute_action, list_cards, move_card, clear_board */
export function registerWarRoomTools(
  server: MCPServer,
  bumpVersion: () => void,
): void {

  server.tool({
    name: "upsert_card",
    description: `Add or update a card on the War Room Kanban board. Use this to visualize progress for ANY task — technical (terminal commands, git ops, DB migrations) or general (trip planning, research, brainstorming). The widget renders cards in a 3-column Kanban (Todo / Doing / Done). Card types: 'command' shows a terminal card with an Execute button, 'task' is a standard task card, 'info' is for context/notes. Always use this tool to structure work visually instead of just replying with text.`,
    schema: z.object({
      id: z.string().optional().describe("Card ID. Omit to auto-generate. Provide to update an existing card."),
      type: z.enum(["command", "info", "task"]).describe("Card type: 'command' for terminal/shell, 'task' for action items, 'info' for context/reference"),
      title: z.string().min(1).describe("Card title (short, descriptive)"),
      content: z.string().describe("Card body text: description, notes, or for 'command' type the human-readable explanation"),
      status: z.enum(["pending", "active", "done"]).default("pending").describe("Card status"),
      column: z.enum(["todo", "doing", "done"]).default("todo").describe("Which Kanban column to place the card in"),
      command: z.string().optional().describe("For type='command': the shell command to execute when user clicks Execute"),
      category: z.string().optional().describe("Category tag (e.g. 'Database', 'API', 'UI', 'Restaurant', 'Flight')"),
      icon: z.string().optional().describe("Icon hint: 'database', 'globe', 'terminal', 'code', 'utensils', 'plane', 'search', 'check', 'alert', 'rocket'"),
    }),
  }, async (args: any) => {
    const cardId = args.id || generateId();
    const existing = warRoomCards.get(cardId);
    const ts = now();

    const card: WarRoomCard = {
      id: cardId,
      type: args.type as CardType,
      title: args.title,
      content: args.content,
      status: (args.status || "pending") as CardStatus,
      column: (args.column || "todo") as CardColumn,
      command: args.command,
      output: existing?.output,
      executing: false,
      category: args.category,
      icon: args.icon,
      createdAt: existing?.createdAt || ts,
      updatedAt: ts,
    };

    warRoomCards.set(cardId, card);
    bumpVersion();
    log.info(`Card upserted: ${card.title} [${card.type}] → ${card.column}`);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          card_id: cardId,
          title: card.title,
          type: card.type,
          column: card.column,
          status: card.status,
          message: existing ? "Card updated on War Room board." : "Card added to War Room board.",
        }, null, 2),
      }],
    };
  });

  server.tool({
    name: "execute_action",
    description: "Execute an action on a War Room card. For 'command' cards, this runs the shell command and captures output. For other cards, it moves the card to 'done' and returns a result. Called when a user clicks a button on a card in the widget.",
    schema: z.object({
      card_id: z.string().min(1).describe("The card ID to execute"),
      action: z.enum(["run", "complete", "approve", "dismiss"]).default("run").describe("Action to take: 'run' executes a command card, 'complete' marks done, 'approve'/'dismiss' for info cards"),
    }),
  }, async (args: any) => {
    const card = warRoomCards.get(args.card_id);
    if (!card) {
      return { content: [{ type: "text" as const, text: `Card ${args.card_id} not found.` }] };
    }

    const action = args.action || "run";

    if (action === "run" && card.type === "command" && card.command) {
      card.executing = true;
      card.column = "doing";
      card.status = "active";
      bumpVersion();

      try {
        const { stdout, stderr } = await execAsync(card.command, {
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
          cwd: process.cwd(),
        });
        card.output = stdout || stderr || "(no output)";
        card.executing = false;
        card.column = "done";
        card.status = "done";
        bumpVersion();
        log.info(`Command executed: ${card.command}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              card_id: card.id,
              title: card.title,
              command: card.command,
              output: card.output,
              status: "done",
              message: `Command executed successfully. Output: ${card.output.slice(0, 500)}`,
            }, null, 2),
          }],
        };
      } catch (err: any) {
        card.output = err.stderr || err.message || "Command failed";
        card.executing = false;
        card.status = "active";
        bumpVersion();
        log.error(`Command failed: ${card.command} — ${card.output}`);

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              card_id: card.id,
              title: card.title,
              command: card.command,
              error: card.output,
              status: "error",
              message: `Command failed: ${card.output.slice(0, 500)}`,
            }, null, 2),
          }],
        };
      }
    }

    // For non-command actions: just move the card
    if (action === "complete" || action === "approve") {
      card.column = "done";
      card.status = "done";
    } else if (action === "dismiss") {
      warRoomCards.delete(card.id);
      bumpVersion();
      return { content: [{ type: "text" as const, text: `Card "${card.title}" dismissed.` }] };
    }

    bumpVersion();
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          card_id: card.id,
          title: card.title,
          action,
          status: card.status,
          column: card.column,
          message: `Card "${card.title}" ${action === "complete" ? "completed" : "updated"}.`,
        }, null, 2),
      }],
    };
  });

  server.tool({
    name: "move_card",
    description: "Move a War Room card to a different Kanban column (todo/doing/done).",
    schema: z.object({
      card_id: z.string().min(1).describe("Card ID to move"),
      column: z.enum(["todo", "doing", "done"]).describe("Target column"),
    }),
  }, async (args: any) => {
    const card = warRoomCards.get(args.card_id);
    if (!card) {
      return { content: [{ type: "text" as const, text: `Card ${args.card_id} not found.` }] };
    }

    card.column = args.column;
    card.status = args.column === "done" ? "done" : args.column === "doing" ? "active" : "pending";
    card.updatedAt = now();
    bumpVersion();

    return {
      content: [{
        type: "text" as const,
        text: `Moved "${card.title}" to ${args.column}.`,
      }],
    };
  });

  server.tool({
    name: "list_cards",
    description: "List all cards on the War Room board, optionally filtered by column.",
    schema: z.object({
      column: z.enum(["todo", "doing", "done"]).optional().describe("Filter by column"),
    }),
  }, async (args: any) => {
    let cards = Array.from(warRoomCards.values());
    if (args.column) cards = cards.filter(c => c.column === args.column);

    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({
          count: cards.length,
          cards: cards.map(c => ({
            id: c.id,
            type: c.type,
            title: c.title,
            content: c.content,
            column: c.column,
            status: c.status,
            category: c.category,
            icon: c.icon,
            command: c.command,
            output: c.output,
            executing: c.executing,
          })),
        }, null, 2),
      }],
    };
  });

  server.tool({
    name: "clear_board",
    description: "Clear all cards from the War Room board. Fresh start.",
    schema: z.object({}),
  }, async () => {
    const count = warRoomCards.size;
    warRoomCards.clear();
    bumpVersion();
    return { content: [{ type: "text" as const, text: `Cleared ${count} cards from War Room.` }] };
  });
}
