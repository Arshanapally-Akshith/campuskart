import { useNavigate, useParams } from 'react-router-dom';
import { ListingDetail } from '../components/ListingDetail';

export function ListingDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  if (!id) {
    return null;
  }

  return (
    <ListingDetail
      listingId={id}
      onBack={() => {
        void navigate('/');
      }}
    />
  );
}
