import { useState, useEffect } from 'react';
import { useCreateUser, useUpdateUser, useUserList } from '@/api';
import { Modal } from '@/components/shared';
import { Input, Select, Button, Toggle } from '@/components/ui';
import type { CreateUserRequest, UpdateUserRequest, UserRole } from '@crm-lab/shared';
import { DEFAULT_DISCOUNT_LIMIT } from '@crm-lab/shared';

interface UserModalProps {
  userId?: string;
  onClose: () => void;
}

const ROLE_OPTIONS = [
  { value: 'attendant', label: 'Atendente' },
  { value: 'manager', label: 'Gestor' },
  { value: 'admin', label: 'Administrador' },
];

export default function UserModal({ userId, onClose }: UserModalProps) {
  const [form, setForm] = useState({
    email: '',
    name: '',
    password: '',
    role: 'attendant' as UserRole,
    discountLimit: 15,
    isActive: true,
  });

  const [errors, setErrors] = useState<Record<string, string>>({});

  const createUser = useCreateUser();
  const updateUser = useUpdateUser();

  // Fetch all users if editing
  const { data: usersResponse } = useUserList({ limit: 1000 });
  const allUsers = usersResponse?.users ?? [];
  const editingUser = userId && allUsers.find((u) => u.id === userId);

  useEffect(() => {
    if (editingUser) {
      setForm({
        email: editingUser.email,
        name: editingUser.name,
        password: '',
        role: editingUser.role as UserRole,
        discountLimit: editingUser.discountLimit,
        isActive: editingUser.isActive,
      });
    }
  }, [editingUser]);

  const validateForm = (): boolean => {
    const newErrors: Record<string, string> = {};

    if (!form.email.trim()) {
      newErrors.email = 'Email é obrigatório';
    } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) {
      newErrors.email = 'Email inválido';
    }

    if (!form.name.trim()) {
      newErrors.name = 'Nome é obrigatório';
    }

    if (!userId && !form.password) {
      newErrors.password = 'Senha é obrigatória';
    } else if (form.password && form.password.length < 8) {
      newErrors.password = 'Senha deve ter pelo menos 8 caracteres';
    }

    if (form.discountLimit < 0 || form.discountLimit > 100) {
      newErrors.discountLimit = 'Alçada deve estar entre 0 e 100%';
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) {
      return;
    }

    if (userId) {
      const updateData: UpdateUserRequest = {
        name: form.name,
        role: form.role,
        discountLimit: form.discountLimit,
        isActive: form.isActive,
      };
      updateUser.mutate({ id: userId, data: updateData }, {
        onSuccess: () => onClose(),
      });
    } else {
      const createData: CreateUserRequest = {
        email: form.email,
        name: form.name,
        password: form.password,
        role: form.role,
        discountLimit: form.discountLimit,
      };
      createUser.mutate(createData, {
        onSuccess: () => onClose(),
      });
    }
  };

  const isLoading = createUser.isPending || updateUser.isPending;
  const defaultLimit = DEFAULT_DISCOUNT_LIMIT[form.role];

  return (
    <Modal
      open={true}
      title={userId ? 'Editar Usuário' : 'Novo Usuário'}
      onClose={onClose}
    >
      <form onSubmit={handleSubmit} className="space-y-lg">
        {/* Email */}
        <Input
          label="Email"
          type="email"
          value={form.email}
          onChange={(e) => setForm(prev => ({ ...prev, email: e.target.value }))}
          disabled={!!userId}
          error={errors.email}
          placeholder="usuario@lab.com"
        />

        {/* Nome */}
        <Input
          label="Nome"
          value={form.name}
          onChange={(e) => setForm(prev => ({ ...prev, name: e.target.value }))}
          error={errors.name}
          placeholder="Nome Completo"
        />

        {/* Senha (apenas na criação) */}
        {!userId && (
          <Input
            label="Senha"
            type="password"
            value={form.password}
            onChange={(e) => setForm(prev => ({ ...prev, password: e.target.value }))}
            error={errors.password}
            placeholder="Mínimo 8 caracteres"
          />
        )}

        {/* Função */}
        <Select
          label="Função"
          value={form.role}
          onChange={(e) => {
            const roleOptions: Record<string, UserRole> = {
              attendant: 'attendant',
              manager: 'manager',
              admin: 'admin',
            };
            const role = (roleOptions[e.target.value] ?? 'attendant') as UserRole;
            setForm(prev => ({
              ...prev,
              role,
              discountLimit: prev.discountLimit === DEFAULT_DISCOUNT_LIMIT[Object.keys(DEFAULT_DISCOUNT_LIMIT)[0] as UserRole]
                ? DEFAULT_DISCOUNT_LIMIT[role]
                : prev.discountLimit,
            }));
          }}
          options={ROLE_OPTIONS}
        />

        {/* Alçada de Desconto */}
        <div className="space-y-sm">
          <div className="flex justify-between items-center">
            <label className="text-body-sm font-medium text-neutral-900">Alçada de Desconto</label>
            <span className="text-body-sm text-neutral-500">
              Padrão: {defaultLimit}%
            </span>
          </div>
          <div className="flex items-center gap-md">
            <Input
              type="number"
              min="0"
              max="100"
              value={form.discountLimit ?? ''}
              onChange={(e) => setForm(prev => ({
                ...prev,
                discountLimit: Math.max(0, Math.min(100, parseInt(e.target.value) || 0)),
              }))}
              error={errors.discountLimit}
              placeholder="0"
            />
            <span className="text-body-sm text-neutral-600">%</span>
          </div>
        </div>

        {/* Status Ativo (apenas na edição) */}
        {userId && (
          <div className="flex items-center justify-between">
            <label className="text-body-sm font-medium text-neutral-900">Usuário Ativo</label>
            <Toggle
              checked={form.isActive}
              onChange={(checked) => setForm(prev => ({ ...prev, isActive: checked }))}
            />
          </div>
        )}

        {/* Botões */}
        <div className="flex gap-md pt-lg border-t border-neutral-200">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={isLoading}
          >
            Cancelar
          </Button>
          <Button
            type="submit"
            variant="primary"
            loading={isLoading}
          >
            {userId ? 'Salvar Alterações' : 'Criar Usuário'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
