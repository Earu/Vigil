import { useEffect, useState } from 'react';
import { SuccessIcon, ErrorIcon, InfoIcon, WarningIcon } from '../../icons';
import './Toast.css';

export interface Toast {
	id: string;
	message: string;
	type: 'success' | 'error' | 'info' | 'warning';
	duration?: number;
}

interface ToastProps {
	toast: Toast;
	onRemove: (id: string) => void;
}

const ToastItem = ({ toast, onRemove }: ToastProps) => {
	useEffect(() => {
		if (toast.duration !== 0) { // Only set timeout if duration is not 0 (persistent)
			const timer = setTimeout(() => {
				onRemove(toast.id);
			}, toast.duration || 10000);

			return () => clearTimeout(timer);
		}
	}, [toast.id, toast.duration, onRemove]);

	const iconStyle = { width: '16px', height: '16px' };

	return (
		<div className={`toast ${toast.type}`}>
			{toast.type === 'success' && <SuccessIcon style={iconStyle} />}
			{toast.type === 'error' && <ErrorIcon style={iconStyle} />}
			{toast.type === 'info' && <InfoIcon style={iconStyle} />}
			{toast.type === 'warning' && <WarningIcon style={iconStyle} />}
			{toast.message}
		</div>
	);
};

export const ToastContainer = () => {
	const [toasts, setToasts] = useState<Toast[]>([]);

	const addToast = (toast: Omit<Toast, 'id'>) => {
		const id = Math.random().toString(36).substring(7);
		setToasts((prev) => [...prev, { ...toast, id }]);
		return id;
	};

	const updateToast = (id: string, newToast: Omit<Toast, 'id'>) => {
		setToasts((prev) => prev.map((toast) =>
			toast.id === id ? { ...newToast, id } : toast
		));
	};

	const removeToast = (id: string) => {
		setToasts((prev) => prev.filter((toast) => toast.id !== id));
	};

	// Expose the addToast and updateToast functions globally
	useEffect(() => {
		(window as any).showToast = addToast;
		(window as any).updateToast = updateToast;
		return () => {
			delete (window as any).showToast;
			delete (window as any).updateToast;
		};
	}, []);

	return (
		<div className="toast-container">
			{toasts.map((toast) => (
				<ToastItem key={toast.id} toast={toast} onRemove={removeToast} />
			))}
		</div>
	);
};