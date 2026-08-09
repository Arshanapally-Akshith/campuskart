import { ConversationsList } from '../components/ConversationsList';

export function ConversationsPage() {
  return (
    <div className="flex w-full flex-col gap-4">
      <h1 className="text-lg font-semibold text-slate-900">Messages</h1>
      <ConversationsList />
    </div>
  );
}
