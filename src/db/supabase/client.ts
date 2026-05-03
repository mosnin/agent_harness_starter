/**
 * Supabase DB adapter.
 * Requires tables: agent_threads, agent_messages, agent_runs.
 * Run the migration in prisma/schema.prisma or create them manually in Supabase Studio.
 */

import type { DbAdapter, AgentThread, AgentMessage, AgentRun } from "../types";
import { config } from "@/lib/config";

function getClient() {
  const { createClient } = require("@supabase/supabase-js");
  return createClient(
    config.db.supabase.url,
    config.db.supabase.serviceRoleKey || config.db.supabase.anonKey
  );
}

export const supabaseAdapter: DbAdapter = {
  async createThread(userId, title) {
    const { data, error } = await getClient()
      .from("agent_threads")
      .insert({ user_id: userId, title: title ?? null })
      .select()
      .single();
    if (error) throw error;
    return rowToThread(data);
  },

  async getThread(threadId) {
    const { data, error } = await getClient()
      .from("agent_threads")
      .select()
      .eq("id", threadId)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToThread(data) : null;
  },

  async listThreads(userId) {
    const { data, error } = await getClient()
      .from("agent_threads")
      .select()
      .eq("user_id", userId)
      .order("updated_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(rowToThread);
  },

  async deleteThread(threadId) {
    const { error } = await getClient()
      .from("agent_threads")
      .delete()
      .eq("id", threadId);
    if (error) throw error;
  },

  async saveMessage(msg) {
    const { data, error } = await getClient()
      .from("agent_messages")
      .insert({
        thread_id: msg.threadId,
        role: msg.role,
        content: msg.content,
        tool_call_id: msg.toolCallId ?? null,
        tool_name: msg.toolName ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return rowToMessage(data);
  },

  async getMessages(threadId) {
    const { data, error } = await getClient()
      .from("agent_messages")
      .select()
      .eq("thread_id", threadId)
      .order("created_at", { ascending: true });
    if (error) throw error;
    return (data ?? []).map(rowToMessage);
  },

  async createRun(run) {
    const { data, error } = await getClient()
      .from("agent_runs")
      .insert({
        thread_id: run.threadId,
        status: run.status,
        agent_name: run.agentName,
        error: run.error ?? null,
        metadata: run.metadata ?? null,
      })
      .select()
      .single();
    if (error) throw error;
    return rowToRun(data);
  },

  async updateRun(runId, update) {
    const { data, error } = await getClient()
      .from("agent_runs")
      .update({
        ...(update.status && { status: update.status }),
        ...(update.error !== undefined && { error: update.error }),
        ...(update.completedAt && { completed_at: update.completedAt }),
        ...(update.metadata && { metadata: update.metadata }),
      })
      .eq("id", runId)
      .select()
      .single();
    if (error) throw error;
    return rowToRun(data);
  },

  async getRun(runId) {
    const { data, error } = await getClient()
      .from("agent_runs")
      .select()
      .eq("id", runId)
      .maybeSingle();
    if (error) throw error;
    return data ? rowToRun(data) : null;
  },
};

function rowToThread(row: Record<string, unknown>): AgentThread {
  return {
    id: row.id as string,
    userId: row.user_id as string,
    title: row.title as string | undefined,
    createdAt: new Date(row.created_at as string),
    updatedAt: new Date(row.updated_at as string),
  };
}

function rowToMessage(row: Record<string, unknown>): AgentMessage {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    role: row.role as AgentMessage["role"],
    content: row.content as string,
    toolCallId: row.tool_call_id as string | undefined,
    toolName: row.tool_name as string | undefined,
    createdAt: new Date(row.created_at as string),
  };
}

function rowToRun(row: Record<string, unknown>): AgentRun {
  return {
    id: row.id as string,
    threadId: row.thread_id as string,
    status: row.status as AgentRun["status"],
    agentName: row.agent_name as string,
    startedAt: new Date(row.started_at as string),
    completedAt: row.completed_at ? new Date(row.completed_at as string) : undefined,
    error: row.error as string | undefined,
    metadata: row.metadata as Record<string, unknown> | undefined,
  };
}
