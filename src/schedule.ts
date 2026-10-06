import { DurableObject } from "cloudflare:workers";
import { enqueueBroadcast } from "./delivery";

export class BroadcastSchedule extends DurableObject<Env> {
  async schedule(broadcastId: string, scheduledAt: string): Promise<void> {
    await this.ctx.storage.put("broadcastId", broadcastId);
    await this.ctx.storage.setAlarm(new Date(scheduledAt).getTime());
  }

  async cancel(): Promise<void> {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.delete("broadcastId");
  }

  override async alarm(): Promise<void> {
    const broadcastId = await this.ctx.storage.get<string>("broadcastId");
    if (!broadcastId) return;
    await enqueueBroadcast(this.env, broadcastId);
    await this.ctx.storage.delete("broadcastId");
  }
}
