import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme.dart';

/// El PIN aparece una sola vez, al crear la solicitud.
///
/// Es el único elemento de toda la app que usa el ámbar de seguridad. Se le
/// explica al usuario qué hace el código en una frase, porque un número sin
/// contexto se olvida o se comparte por error.
Future<void> showPinRevealDialog(BuildContext context, {required String pin}) {
  return showDialog(
    context: context,
    barrierDismissible: false,
    builder: (context) => AlertDialog(
      backgroundColor: AppColors.white,
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
      contentPadding: const EdgeInsets.all(AppSpacing.lg),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: AppColors.signal.withOpacity(0.15),
                  borderRadius: BorderRadius.circular(9),
                ),
                child: const Icon(Icons.lock_outline, color: Color(0xFF9A6100), size: 20),
              ),
              const SizedBox(width: AppSpacing.sm),
              const Expanded(child: Text('Tu código de finalización', style: AppTypography.title)),
            ],
          ),
          const SizedBox(height: AppSpacing.md),
          Container(
            width: double.infinity,
            padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
            decoration: BoxDecoration(
              color: AppColors.surface,
              borderRadius: BorderRadius.circular(12),
              border: Border.all(color: AppColors.signal, width: 1.5),
            ),
            child: Center(
              child: Text(pin, style: AppTypography.numeric.copyWith(color: AppColors.ink)),
            ),
          ),
          const SizedBox(height: AppSpacing.md),
          const Text(
            'Dáselo al técnico recién cuando el trabajo esté terminado y lo hayas revisado. '
            'Con ese código se libera el pago retenido.',
            style: AppTypography.body,
          ),
          const SizedBox(height: AppSpacing.sm),
          const Text(
            'Queda guardado en tu solicitud por si lo necesitás de nuevo.',
            style: AppTypography.caption,
          ),
        ],
      ),
      actions: [
        TextButton.icon(
          onPressed: () {
            Clipboard.setData(ClipboardData(text: pin));
            ScaffoldMessenger.of(context).showSnackBar(
              const SnackBar(content: Text('Código copiado')),
            );
          },
          icon: const Icon(Icons.copy, size: 18),
          label: const Text('Copiar'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Entendido'),
        ),
      ],
    ),
  );
}
