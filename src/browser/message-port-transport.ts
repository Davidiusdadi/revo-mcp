import type {
  JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  Transport,
  TransportSendOptions,
} from "@modelcontextprotocol/sdk/shared/transport.js";

export interface MessageEndpoint {
  postMessage(message: unknown): void;
  start?(): void;
  close?(): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  addEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "messageerror", listener: (event: MessageEvent) => void): void;
}

/** MCP transport for a MessageChannel crossing the browser Worker boundary. */
export class MessagePortTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T) => void;

  private started = false;
  private closed = false;

  constructor(private readonly endpoint: MessageEndpoint) {}

  private readonly handleMessage = (event: MessageEvent) => {
    if (this.closed) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.jsonrpc !== "2.0") {
      this.onerror?.(new Error("Invalid MCP message received through MessagePort."));
      return;
    }
    this.onmessage?.(message as JSONRPCMessage);
  };

  private readonly handleMessageError = () => {
    this.onerror?.(new Error("The browser could not deserialize an MCP MessagePort payload."));
  };

  async start(): Promise<void> {
    if (this.closed) throw new Error("Cannot start a closed MessagePort transport.");
    if (this.started) throw new Error("MessagePort transport has already been started.");
    this.started = true;
    this.endpoint.addEventListener("message", this.handleMessage);
    this.endpoint.addEventListener("messageerror", this.handleMessageError);
    this.endpoint.start?.();
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.started || this.closed) throw new Error("MessagePort transport is not open.");
    this.endpoint.postMessage(message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.endpoint.removeEventListener("message", this.handleMessage);
    this.endpoint.removeEventListener("messageerror", this.handleMessageError);
    this.endpoint.close?.();
    this.onclose?.();
  }
}

