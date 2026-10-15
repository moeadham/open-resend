import { adminApp } from "./admin";
import { apiApp } from "./api";
import { isAdminRequest, isApiRequest } from "./auth";
import { logError } from "./lib";
import { processBroadcastQueueMessage, processDeadLetter, processDeliveryMessage, processEmailEvent } from "./delivery";
import type { BroadcastQueueMessage, DeliveryQueueMessage, EmailEventMessage, QueueBody } from "./types";

export { BroadcastSchedule } from "./schedule";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      if (isAdminRequest(request, env)) return adminApp.fetch(request, env);
      if (isApiRequest(request, env)) return apiApp.fetch(request, env);
      return Response.json({
        name: "not_found",
        message: "This hostname is not configured for the service.",
        statusCode: 404,
      }, { status: 404 });
    } catch (error) {
      logError("unhandled fetch error", error, { path: new URL(request.url).pathname });
      return Response.json({ name: "application_error", message: "Internal server error.", statusCode: 500 }, { status: 500 });
    }
  },

  async queue(batch: MessageBatch<QueueBody>, env: Env): Promise<void> {
    if (batch.queue === env.DEAD_LETTER_QUEUE_NAME) {
      await processDeadLetter(batch as MessageBatch<DeliveryQueueMessage | BroadcastQueueMessage>, env);
      return;
    }
    if (batch.queue !== env.EMAIL_EVENTS_QUEUE_NAME && batch.queue !== env.DELIVERY_QUEUE_NAME) {
      throw new Error(`Received a batch from an unconfigured queue: ${batch.queue}`);
    }
    for (const message of batch.messages) {
      try {
        if (batch.queue === env.EMAIL_EVENTS_QUEUE_NAME) {
          await processEmailEvent(message as Message<EmailEventMessage>, env);
        } else if ("broadcastId" in message.body) {
          await processBroadcastQueueMessage(message as Message<BroadcastQueueMessage>, env);
        } else {
          await processDeliveryMessage(message as Message<DeliveryQueueMessage>, env);
        }
      } catch (error) {
        logError("queue message failed", error, { queue: batch.queue, messageId: message.id });
        message.retry();
      }
    }
  },
} satisfies ExportedHandler<Env, QueueBody>;
