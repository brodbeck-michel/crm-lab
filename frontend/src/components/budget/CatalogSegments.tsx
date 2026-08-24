import { useState } from 'react';
import { useExamList } from '@/api/exams';
import { SearchInput, SegmentedControl } from '@/components/ui';
import { MoneyDisplay } from '@/components/shared/MoneyDisplay';

interface CatalogSegmentsProps {
  onAddItem: (examId: string, examName: string, price: number) => void;
}

export default function CatalogSegments({ onAddItem }: CatalogSegmentsProps) {
  const [search, setSearch] = useState('');
  const [segment, setSegment] = useState<'catalog' | 'medical' | 'ai' | 'packages'>('catalog');
  const [pricingMode, setPricingMode] = useState<'private' | 'insurance'>('private');

  const { data, isLoading } = useExamList({
    active: true,
    search,
    limit: 50,
  });

  const exams = data || [];

  const handleAddExam = (examId: string, examName: string) => {
    const exam = exams.find((e) => e.id === examId);
    if (exam) {
      const price =
        pricingMode === 'private' ? exam.pricePrivate : exam.priceInsurance;
      onAddItem(examId, examName, price);
    }
  };

  return (
    <div className="flex flex-col gap-4 p-5 h-full">
      <h2 className="font-heading text-section">Catálogo</h2>

      <SegmentedControl
        options={[
          { label: 'Catálogo', value: 'catalog' },
          { label: 'Pedido Médico', value: 'medical' },
          { label: 'IA', value: 'ai' },
          { label: 'Pacotes', value: 'packages' },
        ]}
        value={segment}
        onChange={(val) => setSegment(val as 'catalog' | 'medical' | 'ai' | 'packages')}
      />

      <SegmentedControl
        options={[
          { label: 'Particular', value: 'private' },
          { label: 'Convênio', value: 'insurance' },
        ]}
        value={pricingMode}
        onChange={(val) => setPricingMode(val as 'private' | 'insurance')}
      />

      <SearchInput
        placeholder="Buscar exame..."
        onSearch={setSearch}
      />

      {isLoading ? (
        <div className="flex items-center justify-center py-8 text-neutral-600">
          Carregando...
        </div>
      ) : exams.length === 0 ? (
        <div className="flex items-center justify-center py-8 text-neutral-600">
          Nenhum exame encontrado
        </div>
      ) : (
        <div className="space-y-2 overflow-y-auto flex-1">
          {exams.map((exam) => (
            <button
              key={exam.id}
              onClick={() => handleAddExam(exam.id, exam.name)}
              className="w-full flex justify-between items-center p-3 hover:bg-neutral-100 rounded-md transition-colors text-left"
            >
              <div className="flex-1 min-w-0">
                <p className="text-label font-semibold truncate">{exam.name}</p>
                {exam.code && (
                  <p className="text-caption text-neutral-600">{exam.code}</p>
                )}
              </div>
              <MoneyDisplay
                value={
                  pricingMode === 'private'
                    ? exam.pricePrivate
                    : exam.priceInsurance
                }
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
