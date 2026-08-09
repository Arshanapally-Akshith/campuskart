import { useNavigate } from 'react-router-dom';
import { ListingForm } from '../components/ListingForm';

export function CreateListingPage() {
  const navigate = useNavigate();

  return (
    <ListingForm
      onCancel={() => {
        void navigate('/');
      }}
      onSaved={(saved) => {
        void navigate(`/listings/${saved.id}`);
      }}
    />
  );
}
