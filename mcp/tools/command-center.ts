import { MCPServer } from "mcp-use/server";
import { z } from "zod";
import type { CommandCenterState, CCModule, CCEmail, CCFlight, CCHotel, CCEvent, CCTerminalEntry } from "../types.js";
import { generateId, now, Logger } from "../../shared/utils.js";
import { commandCenter, workspace } from "../workspace.js";
import { getConnectionStatus } from "./google-integration.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);
const log = new Logger("CommandCenter");

// ── Mock data generators ────────────────────────────────────────────────

function mockEmails(): CCEmail[] {
  return [
    {
      id: generateId(), from: "sarah@acme.com", subject: "Q1 Board Deck — Final Review",
      preview: "Hi team, attached is the final Q1 deck. Please review slides 12-18 on revenue projections before tomorrow's meeting.",
      date: "2026-02-21T09:15:00Z", read: false, starred: true, labels: ["urgent", "finance"],
      body: "Hi team,\n\nAttached is the final Q1 deck. Please review slides 12-18 on revenue projections before tomorrow's board meeting at 2 PM.\n\nKey changes since last draft:\n- Updated ARR to $4.2M\n- Added churn analysis on slide 15\n- New customer logos on slide 18\n\nPlease flag any issues by EOD.\n\nBest,\nSarah",
    },
    {
      id: generateId(), from: "travel@kayak.com", subject: "Price Alert: SFO → NYC $189 roundtrip",
      preview: "Great deal! Prices dropped 42% for your saved route San Francisco to New York. Available Mar 5-9.",
      date: "2026-02-21T08:30:00Z", read: false, starred: false, labels: ["travel"],
    },
    {
      id: generateId(), from: "mike@eng.team", subject: "Re: Database migration plan",
      preview: "Sounds good. Let's do the migration this Saturday during the maintenance window. I'll prep the rollback scripts.",
      date: "2026-02-21T07:45:00Z", read: true, starred: false, labels: ["engineering"],
    },
    {
      id: generateId(), from: "calendar@google.com", subject: "Reminder: Team dinner at Nopa — Friday 7pm",
      preview: "You have an upcoming event: Team dinner at Nopa, 560 Divisadero St, SF. Party of 8.",
      date: "2026-02-20T18:00:00Z", read: true, starred: false, labels: ["social"],
    },
    {
      id: generateId(), from: "jen@marketing.co", subject: "Launch campaign assets ready",
      preview: "All creative assets for the March launch are uploaded to Figma. Banner ads, social posts, and email templates are in the shared folder.",
      date: "2026-02-20T16:30:00Z", read: true, starred: false, labels: ["marketing"],
    },
  ];
}

function mockFlights(from: string, to: string): CCFlight[] {
  const airlines = ["United", "Delta", "JetBlue", "American", "Alaska"];
  const prices = [189, 214, 247, 179, 299];
  const stops = [0, 1, 0, 1, 0];
  const departures = ["06:00", "08:30", "11:15", "14:00", "17:45"];
  const arrivals = ["14:25", "17:00", "19:30", "22:45", "01:55+1"];

  return airlines.map((a, i) => ({
    id: generateId(),
    airline: a,
    flightNo: `${a.substring(0, 2).toUpperCase()}${1000 + Math.floor(Math.random() * 9000)}`,
    from, to,
    departure: departures[i],
    arrival: arrivals[i],
    price: prices[i],
    currency: "USD",
    stops: stops[i],
    selected: false,
  }));
}

function mockEvents(): CCEvent[] {
  return [
    { id: generateId(), title: "Stand-up", date: "2026-02-21", time: "09:00", duration: "15m", location: "Zoom", color: "#3b82f6" },
    { id: generateId(), title: "Board Meeting", date: "2026-02-21", time: "14:00", duration: "1h", location: "Conference Room A", attendees: ["Sarah", "Mike", "Jen"], color: "#f97316" },
    { id: generateId(), title: "Team Dinner", date: "2026-02-21", time: "19:00", duration: "2h", location: "Nopa, SF", attendees: ["Team"], color: "#22c55e" },
    { id: generateId(), title: "Flight to NYC", date: "2026-03-05", time: "08:30", duration: "5h30m", color: "#a855f7" },
  ];
}

function mockHotels(city: string): CCHotel[] {
  const hotels = [
    { name: "The Greenwich Hotel", stars: 5, price: 495, rating: 4.8, reviews: 2341, amenities: ["spa", "pool", "gym", "restaurant"] },
    { name: "Hyatt Place Downtown", stars: 3, price: 189, rating: 4.3, reviews: 1856, amenities: ["gym", "breakfast", "wifi"] },
    { name: "The Standard Hotel", stars: 4, price: 329, rating: 4.5, reviews: 3102, amenities: ["rooftop", "gym", "restaurant", "bar"] },
    { name: "Pod Hotel Brooklyn", stars: 3, price: 129, rating: 4.1, reviews: 4523, amenities: ["wifi", "rooftop", "coffee"] },
    { name: "Marriott Marquis", stars: 4, price: 359, rating: 4.4, reviews: 5678, amenities: ["pool", "gym", "restaurant", "concierge"] },
  ];

  return hotels.map(h => ({
    id: generateId(),
    name: h.name,
    location: city,
    stars: h.stars,
    pricePerNight: h.price,
    currency: "USD",
    amenities: h.amenities,
    rating: h.rating,
    reviewCount: h.reviews,
    selected: false,
  }));
}

// ── Tool Registration ───────────────────────────────────────────────────

export function registerCommandCenterTools(
  server: MCPServer,
  bumpVersion: () => void,
): void {

  // ── activate_module ─────────────────────────────────────────────────
  server.tool({
    name: "activate_module",
    description: "Activate a module on the Command Center dashboard. This makes the module's panel visible in the widget. Modules: 'email' (inbox), 'travel' (flights/hotels), 'calendar' (events), 'terminal' (shell). Activate multiple modules to show a split-view workspace.",
    schema: z.object({
      modules: z.array(z.enum(["email", "travel", "calendar", "terminal", "hotels"])).min(1)
        .describe("Modules to activate (e.g., ['email', 'travel', 'hotels'])"),
    }),
  }, async (args: any) => {
    const modules = args.modules as CCModule[];
    modules.forEach(m => {
      if (!commandCenter.activeModules.includes(m)) {
        commandCenter.activeModules.push(m);
      }
    });
    commandCenter.lastUpdated = now();
    bumpVersion();
    log.info(`Modules activated: ${modules.join(", ")}`);
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify({ activeModules: commandCenter.activeModules, message: `Activated: ${modules.join(", ")}` }, null, 2),
      }],
    };
  });

  // ── sync_context ────────────────────────────────────────────────────
  // DISABLED: No mock data. Use check_email for real Gmail, read_calendar for real Calendar.
  server.tool({
    name: "sync_context",
    description: "DISABLED — Mock data is disabled. Use check_email for real Gmail inbox, read_calendar for real Google Calendar. Do NOT call this tool.",
    schema: z.object({
      source: z.enum(["email", "calendar"]).describe("Data source to sync"),
    }),
  }, async () => {
    return {
      content: [{
        type: "text" as const,
        text: "Mock data is disabled. Use check_email to load real Gmail, or read_calendar to load real Google Calendar. Connect your Google account via google_login first.",
      }],
      isError: true,
    };
  });

  // ── find_options ────────────────────────────────────────────────────
  // DISABLED: No mock data. Real travel API required.
  server.tool({
    name: "find_options",
    description: "DISABLED — Mock data is disabled. Use check_email for real Gmail, read_calendar for real Calendar. No travel API connected.",
    schema: z.object({
      type: z.enum(["flights"]).describe("Search type"),
      from: z.string().min(1).describe("Departure city/airport (e.g., 'SFO')"),
      to: z.string().min(1).describe("Arrival city/airport (e.g., 'NYC')"),
      date: z.string().optional().describe("Travel date (e.g., '2026-03-05')"),
    }),
  }, async () => {
    return {
      content: [{ type: "text" as const, text: "Mock travel data is disabled. Use check_email for real Gmail, read_calendar for real Calendar." }],
      isError: true,
    };
  });

  // ── find_hotels ────────────────────────────────────────────────────
  // DISABLED: No mock data.
  server.tool({
    name: "find_hotels",
    description: "DISABLED — Mock data is disabled. Use check_email for real Gmail, read_calendar for real Calendar.",
    schema: z.object({
      city: z.string().min(1).describe("City to search hotels in (e.g., 'New York')"),
      checkin: z.string().optional().describe("Check-in date (e.g., '2026-03-05')"),
      checkout: z.string().optional().describe("Check-out date (e.g., '2026-03-07')"),
    }),
  }, async () => {
    return {
      content: [{ type: "text" as const, text: "Mock travel data is disabled. Use check_email for real Gmail, read_calendar for real Calendar." }],
      isError: true,
    };
  });

  // ── plan_trip ─────────────────────────────────────────────────────
  // DISABLED: No mock data. Use check_email + read_calendar for real data.
  server.tool({
    name: "plan_trip",
    description: "DISABLED — Mock data is disabled. Use check_email for real Gmail, read_calendar for real Calendar. Focus on Meeting Kit + investor meeting prep.",
    schema: z.object({
      destination: z.string().optional().describe("Destination city (auto-detected from email if not provided)"),
      from: z.string().optional().describe("Departure city/airport (default: SFO)"),
      date: z.string().optional().describe("Travel date"),
    }),
  }, async () => {
    return {
      content: [{ type: "text" as const, text: "Mock travel data is disabled. Use check_email for real Gmail, read_calendar for real Calendar. Prepare investor meetings with the Meeting Kit instead." }],
      isError: true,
    };
  });

  // ── execute_action ──────────────────────────────────────────────────
  server.tool({
    name: "cc_execute_action",
    description: "Execute an action from the Command Center UI. Actions: 'book_flight' (book a selected flight), 'archive_email' (archive an email), 'star_email' (star/unstar), 'add_event' (add to calendar), 'run_command' (execute shell command). This is the main tool called by widget buttons via useCallTool.",
    schema: z.object({
      action: z.enum(["book_flight", "book_hotel", "archive_email", "star_email", "mark_read", "add_event", "run_command", "dismiss_module"])
        .describe("Action to execute"),
      target_id: z.string().optional().describe("ID of the target item (email, flight, event)"),
      payload: z.record(z.string(), z.unknown()).optional().describe("Additional data for the action"),
    }),
  }, async (args: any) => {
    const action = args.action as string;
    const targetId = args.target_id as string | undefined;
    const payload = (args.payload || {}) as Record<string, unknown>;

    commandCenter.status = "processing";
    bumpVersion();

    let resultMsg = "";

    switch (action) {
      case "book_flight": {
        const flight = commandCenter.data.flights.find(f => f.id === targetId);
        if (!flight) { resultMsg = "Flight not found."; break; }
        commandCenter.data.flights.forEach(f => f.selected = false);
        flight.selected = true;
        const flightDate = (payload.date as string) || new Date(Date.now() + 7 * 86400_000).toISOString().split("T")[0];
        commandCenter.data.events.push({
          id: generateId(),
          title: `✈️ ${flight.airline} ${flight.flightNo} — ${flight.from}→${flight.to}`,
          date: flightDate,
          time: flight.departure,
          duration: "5h30m",
          color: "#a855f7",
        });
        if (!commandCenter.activeModules.includes("calendar")) {
          commandCenter.activeModules.push("calendar");
        }
        commandCenter.actions.push({
          id: generateId(), module: "travel", label: "Booked Flight",
          description: `${flight.airline} ${flight.flightNo} $${flight.price}`,
          status: "done", timestamp: now(),
        });
        resultMsg = `Booked ${flight.airline} ${flight.flightNo} (${flight.from}→${flight.to}) for $${flight.price}. Added to calendar.`;
        break;
      }
      case "book_hotel": {
        const hotel = commandCenter.data.hotels.find(h => h.id === targetId);
        if (!hotel) { resultMsg = "Hotel not found."; break; }
        commandCenter.data.hotels.forEach(h => h.selected = false);
        hotel.selected = true;
        const hotelDate = (payload.date as string) || new Date(Date.now() + 7 * 86400_000).toISOString().split("T")[0];
        commandCenter.data.events.push({
          id: generateId(),
          title: `🏨 ${hotel.name} — ${hotel.location}`,
          date: hotelDate,
          time: "15:00",
          duration: "2 nights",
          location: hotel.name,
          color: "#ec4899",
        });
        if (!commandCenter.activeModules.includes("calendar")) {
          commandCenter.activeModules.push("calendar");
        }
        commandCenter.actions.push({
          id: generateId(), module: "hotels", label: "Booked Hotel",
          description: `${hotel.name} $${hotel.pricePerNight}/night`,
          status: "done", timestamp: now(),
        });
        resultMsg = `Booked ${hotel.name} in ${hotel.location} at $${hotel.pricePerNight}/night. Added to calendar.`;
        break;
      }
      case "archive_email": {
        commandCenter.data.emails = commandCenter.data.emails.filter(e => e.id !== targetId);
        commandCenter.actions.push({
          id: generateId(), module: "email", label: "Archived Email",
          description: `Removed email ${targetId?.slice(0, 8)}`,
          status: "done", timestamp: now(),
        });
        resultMsg = "Email archived.";
        break;
      }
      case "star_email": {
        const email = commandCenter.data.emails.find(e => e.id === targetId);
        if (email) { email.starred = !email.starred; resultMsg = email.starred ? "Email starred." : "Star removed."; }
        break;
      }
      case "mark_read": {
        const email = commandCenter.data.emails.find(e => e.id === targetId);
        if (email) { email.read = true; resultMsg = "Marked as read."; }
        break;
      }
      case "add_event": {
        const evt: CCEvent = {
          id: generateId(),
          title: (payload.title as string) || "New Event",
          date: (payload.date as string) || "2026-02-22",
          time: (payload.time as string) || "12:00",
          duration: (payload.duration as string) || "1h",
          location: payload.location as string | undefined,
          color: "#3b82f6",
        };
        commandCenter.data.events.push(evt);
        if (!commandCenter.activeModules.includes("calendar")) {
          commandCenter.activeModules.push("calendar");
        }
        resultMsg = `Event "${evt.title}" added to calendar.`;
        break;
      }
      case "run_command": {
        const cmd = (payload.command as string) || "echo 'No command specified'";
        if (!commandCenter.activeModules.includes("terminal")) {
          commandCenter.activeModules.push("terminal");
        }
        try {
          const { stdout, stderr } = await execAsync(cmd, { timeout: 15000, maxBuffer: 512 * 1024, cwd: process.cwd() });
          const entry: CCTerminalEntry = {
            id: generateId(), command: cmd,
            output: stdout || stderr || "(no output)",
            exitCode: 0, timestamp: now(),
          };
          commandCenter.data.terminal.push(entry);
          resultMsg = `Command executed. Output: ${entry.output.slice(0, 300)}`;
        } catch (err: any) {
          const entry: CCTerminalEntry = {
            id: generateId(), command: cmd,
            output: err.stderr || err.message || "Failed",
            exitCode: err.code || 1, timestamp: now(),
          };
          commandCenter.data.terminal.push(entry);
          resultMsg = `Command failed: ${entry.output.slice(0, 200)}`;
        }
        break;
      }
      case "dismiss_module": {
        const mod = (payload.module as CCModule) || (targetId as CCModule);
        commandCenter.activeModules = commandCenter.activeModules.filter(m => m !== mod);
        resultMsg = `Module "${mod}" dismissed.`;
        break;
      }
      default:
        resultMsg = `Unknown action: ${action}`;
    }

    commandCenter.status = commandCenter.data.flights.some(f => !f.selected) && commandCenter.activeModules.includes("travel")
      ? "awaiting_user" : "idle";
    commandCenter.statusMessage = resultMsg;
    commandCenter.lastUpdated = now();
    bumpVersion();
    log.info(`Action ${action}: ${resultMsg}`);

    return { content: [{ type: "text" as const, text: resultMsg }] };
  });

  // ── get_workspace ──────────────────────────────────────────────────
  server.tool({
    name: "get_workspace",
    description: "Get the full Command Center workspace state including all data (emails, flights, hotels, events, terminal). The command-center widget calls this via callTool to render its panels. Returns the complete state object with googleConnection for widget display.",
    schema: z.object({}),
  }, async (_args: any, ctx: any) => {
    const state = { ...commandCenter };
    const conn = getConnectionStatus(ctx);
    (state as any).googleConnection = conn;
    return {
      content: [{
        type: "text" as const,
        text: JSON.stringify(state),
      }],
    };
  });
}
