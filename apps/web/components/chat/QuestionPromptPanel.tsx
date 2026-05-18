'use client';

import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, HelpCircle, SendHorizontal, X } from 'lucide-react';
import clsx from 'clsx';
import type { UserQuestion, UserQuestionAnswer, UserQuestionRequest } from '@agenthub/shared-types';
import { useConversationStore } from '@/lib/store';

const OTHER_ID = '__other__';
const EMPTY_QUESTION_REQUESTS: UserQuestionRequest[] = [];

export function QuestionPromptPanel({ conversationId }: { conversationId: string }) {
  const requests = useConversationStore((s) => s.pendingQuestionsByConv[conversationId] ?? EMPTY_QUESTION_REQUESTS);
  const answerUserQuestion = useConversationStore((s) => s.answerUserQuestion);
  const request = requests[0];
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [notes, setNotes] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!request) return;
    const defaults: Record<string, string[]> = {};
    for (const question of request.questions) {
      const recommended = question.options.find((option) => option.recommended);
      defaults[question.id] = recommended ? [recommended.id] : [];
    }
    setSelected(defaults);
    setNotes({});
  }, [request?.id]);

  const ready = useMemo(() => {
    if (!request) return false;
    return request.questions.every((question) => {
      const ids = selected[question.id] ?? [];
      const note = notes[question.id]?.trim();
      return ids.length > 0 || Boolean(note);
    });
  }, [notes, request, selected]);

  if (!request) return null;

  const submit = () => {
    if (!ready) return;
    const answers: UserQuestionAnswer[] = request.questions.map((question) =>
      buildAnswer(question, selected[question.id] ?? [], notes[question.id]),
    );
    answerUserQuestion(conversationId, request.id, answers, request.resumePrompt);
  };

  return (
    <div className="mb-3 rounded-lg border border-accent/25 bg-accent/5 p-3 shadow-sm">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded border border-accent/25 bg-accent/10 text-accent">
          <HelpCircle className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text">{request.title}</span>
            <span className="rounded bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent">
              {request.sourceAgentName}
            </span>
          </div>
          {request.reason ? (
            <p className="mt-1 text-[11px] leading-relaxed text-text-muted">{request.reason}</p>
          ) : null}
        </div>
      </div>

      <div className="mt-3 space-y-3">
        {request.questions.map((question) => (
          <QuestionBlock
            key={question.id}
            question={question}
            selected={selected[question.id] ?? []}
            note={notes[question.id] ?? ''}
            onToggle={(optionId) =>
              setSelected((prev) => ({
                ...prev,
                [question.id]: nextSelection(question, prev[question.id] ?? [], optionId),
              }))
            }
            onNote={(value) => setNotes((prev) => ({ ...prev, [question.id]: value }))}
          />
        ))}
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="text-[10px] text-text-muted">
          回答后组长会带着这些选择继续规划，不会重新猜你的需求。
        </div>
        <button
          type="button"
          onClick={submit}
          disabled={!ready}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white hover:bg-accent-hover disabled:opacity-40"
        >
          <SendHorizontal className="h-3.5 w-3.5" />
          提交选择
        </button>
      </div>
    </div>
  );
}

function QuestionBlock({
  question,
  selected,
  note,
  onToggle,
  onNote,
}: {
  question: UserQuestion;
  selected: string[];
  note: string;
  onToggle: (optionId: string) => void;
  onNote: (value: string) => void;
}) {
  const customSelected = selected.includes(OTHER_ID);

  return (
    <div className="rounded-md border border-white/10 bg-bg-soft/65 p-2.5">
      <div className="flex items-start gap-2">
        <span className="rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted">
          {question.header}
        </span>
        <div className="min-w-0 flex-1 text-xs font-medium leading-relaxed text-text">
          {question.question}
        </div>
      </div>
      <div className="mt-2 grid gap-1.5">
        {[...question.options, otherOption()].map((option) => {
          const active = selected.includes(option.id);
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onToggle(option.id)}
              className={clsx(
                'flex w-full items-start gap-2 rounded-md border px-2.5 py-2 text-left transition',
                active
                  ? 'border-accent/40 bg-accent/10 text-text'
                  : 'border-white/10 bg-bg/45 text-text-muted hover:bg-white/5 hover:text-text',
              )}
            >
              <span
                className={clsx(
                  'mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded border',
                  active ? 'border-accent bg-accent text-white' : 'border-white/20',
                )}
              >
                {active ? <CheckCircle2 className="h-3 w-3" /> : null}
              </span>
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-1.5 text-xs font-medium">
                  {option.label}
                  {option.recommended ? (
                    <span className="rounded bg-accent/15 px-1.5 py-0.5 text-[9px] text-accent">
                      Recommended
                    </span>
                  ) : null}
                </span>
                <span className="mt-0.5 block text-[11px] leading-relaxed opacity-80">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {customSelected ? (
        <div className="mt-2 flex items-start gap-2 rounded border border-white/10 bg-bg/55 px-2 py-1.5">
          <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-text-muted" />
          <textarea
            value={note}
            onChange={(event) => onNote(event.target.value)}
            rows={2}
            placeholder="写下你的自定义要求或补充约束"
            className="min-h-[40px] flex-1 resize-none bg-transparent text-xs leading-relaxed text-text outline-none placeholder:text-text-muted"
          />
        </div>
      ) : null}
    </div>
  );
}

function nextSelection(question: UserQuestion, current: string[], optionId: string): string[] {
  if (!question.multiSelect) return current.includes(optionId) ? [] : [optionId];
  return current.includes(optionId)
    ? current.filter((id) => id !== optionId)
    : [...current, optionId];
}

function buildAnswer(question: UserQuestion, selectedIds: string[], note?: string): UserQuestionAnswer {
  const labels = selectedIds
    .filter((id) => id !== OTHER_ID)
    .map((id) => question.options.find((option) => option.id === id)?.label)
    .filter((label): label is string => Boolean(label));
  const custom = selectedIds.includes(OTHER_ID) ? note?.trim() : undefined;
  const answer = [...labels, custom].filter(Boolean).join(', ') || note?.trim() || '未选择';
  return {
    questionId: question.id,
    question: question.question,
    answer,
    optionIds: selectedIds.filter((id) => id !== OTHER_ID),
    ...(note?.trim() ? { notes: note.trim() } : {}),
  };
}

function otherOption(): UserQuestion['options'][number] {
  return {
    id: OTHER_ID,
    label: '其他',
    description: '我想输入不同的要求或补充更具体的约束。',
  };
}
