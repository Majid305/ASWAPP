import React, { useMemo, useState, useEffect } from 'react';
import { Check, Copy, ExternalLink, MessageCircle, Monitor, Phone, X } from 'lucide-react';
import {
  buildWhatsAppNativeAppUrl,
  buildWhatsAppWebUrl,
  normalizeMoroccanPhone,
} from '../utils/whatsappUtils';

export interface WhatsAppMessageModalProps {
  open: boolean;
  onClose: () => void;
  recipientName: string;
  recipientPhone: string;
  defaultMessage: string;
  title?: string;
  subtitle?: string;
}

export const WhatsAppMessageModal: React.FC<WhatsAppMessageModalProps> = ({
  open,
  onClose,
  recipientName,
  recipientPhone,
  defaultMessage,
  title = 'Envoi WhatsApp Client',
  subtitle = 'Normalisation E.164 (Maroc) & Envoi Bi-Canal',
}) => {
  const [message, setMessage] = useState(defaultMessage);
  const [copied, setCopied] = useState(false);
  const [manualPhone, setManualPhone] = useState(recipientPhone);

  useEffect(() => {
    if (open) {
      setMessage(defaultMessage);
      setManualPhone(recipientPhone);
      setCopied(false);
    }
  }, [open, defaultMessage, recipientPhone]);

  const phoneNorm = useMemo(() => normalizeMoroccanPhone(manualPhone), [manualPhone]);

  if (!open) return null;

  const handleCopy = async () => {
    try {
      if (navigator.clipboard) {
        await navigator.clipboard.writeText(message);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }
    } catch {}
  };

  const handleLaunchWindowsApp = () => {
    if (!phoneNorm.isValid) return;
    window.location.href = buildWhatsAppNativeAppUrl(phoneNorm.e164Digits, message);
  };

  const handleLaunchWeb = () => {
    if (!phoneNorm.isValid) return;
    window.open(buildWhatsAppWebUrl(phoneNorm.e164Digits, message), '_blank', 'noopener,noreferrer');
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/60 backdrop-blur-xs flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-xl max-w-lg w-full p-5 text-xs shadow-2xl space-y-4">
        <div className="flex items-center justify-between border-b pb-3">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-emerald-600 text-white flex items-center justify-center">
              <MessageCircle className="w-4 h-4" />
            </div>
            <div>
              <h3 className="font-bold text-sm text-slate-900 dark:text-white">{title}</h3>
              <p className="text-[11px] text-slate-500">{subtitle}</p>
            </div>
          </div>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-slate-700 text-base">
            ✕
          </button>
        </div>

        {/* Destinataire & Numéro E.164 */}
        <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg space-y-2 border">
          <div className="flex justify-between items-center">
            <span className="font-semibold text-slate-700 dark:text-slate-300">Client : {recipientName}</span>
            <span className={`font-mono font-bold ${phoneNorm.isValid ? 'text-emerald-600' : 'text-red-500'}`}>
              {phoneNorm.isValid ? phoneNorm.formattedInternational : 'Numéro non valide'}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Phone className="w-3.5 h-3.5 text-slate-400" />
            <input
              type="text"
              value={manualPhone}
              onChange={(e) => setManualPhone(e.target.value)}
              className="w-full px-2 py-1 font-mono border rounded bg-white dark:bg-slate-900 text-xs"
              placeholder="06... / 07... / +212..."
            />
          </div>
        </div>

        {/* Message modifiable */}
        <div className="space-y-1">
          <div className="flex justify-between items-center">
            <label className="font-medium text-slate-700 dark:text-slate-300">Message à envoyer :</label>
            <button type="button" onClick={handleCopy} className="text-blue-600 hover:underline flex items-center gap-1">
              {copied ? <Check className="w-3 h-3 text-emerald-600" /> : <Copy className="w-3 h-3" />}
              <span>{copied ? 'Copié !' : 'Copier'}</span>
            </button>
          </div>
          <textarea
            rows={4}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            className="w-full p-2.5 border rounded-lg bg-white dark:bg-slate-900 font-sans text-xs focus:outline-none"
          />
        </div>

        {/* Boutons Bi-Canal */}
        <div className="grid grid-cols-2 gap-2.5 pt-2 border-t">
          <button
            type="button"
            disabled={!phoneNorm.isValid || !message.trim()}
            onClick={handleLaunchWindowsApp}
            className="p-3 border-2 border-emerald-600 bg-emerald-50 dark:bg-emerald-950/40 text-emerald-900 dark:text-emerald-200 rounded-lg text-left hover:bg-emerald-100 disabled:opacity-40"
          >
            <div className="flex items-center gap-1.5 font-bold mb-1">
              <Monitor className="w-4 h-4 text-emerald-600" />
              <span>App Windows 11</span>
            </div>
            <p className="text-[10px] text-slate-600 dark:text-slate-300">Ouvre WhatsApp installé sur le PC</p>
          </button>

          <button
            type="button"
            disabled={!phoneNorm.isValid || !message.trim()}
            onClick={handleLaunchWeb}
            className="p-3 border border-slate-300 dark:border-slate-700 bg-white dark:bg-slate-800 rounded-lg text-left hover:bg-slate-50 disabled:opacity-40"
          >
            <div className="flex items-center gap-1.5 font-bold mb-1">
              <ExternalLink className="w-4 h-4 text-blue-600" />
              <span>WhatsApp Web</span>
            </div>
            <p className="text-[10px] text-slate-500">Ouvre un onglet web.whatsapp.com</p>
          </button>
        </div>

        <div className="flex justify-end pt-1">
          <button type="button" onClick={onClose} className="px-4 py-1.5 border rounded hover:bg-slate-100">
            Fermer
          </button>
        </div>
      </div>
    </div>
  );
};
