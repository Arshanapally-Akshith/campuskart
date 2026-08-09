import { useNavigate, useParams } from 'react-router-dom';
import { ChatPanel } from '../components/ChatPanel';

export function ConversationDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  if (!id) {
    return null;
  }

  return (
    // Keyed on conversationId: switching conversations remounts the panel
    // (and useConversationChat's internal state) instead of needing to
    // manually reset state inside an effect keyed to a prop change.
    <ChatPanel
      key={id}
      conversationId={id}
      onBack={() => {
        void navigate('/conversations');
      }}
    />
  );
}
