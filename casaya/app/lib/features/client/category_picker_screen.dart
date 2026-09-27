import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../core/theme.dart';
import '../../data/repositories.dart';
import '../../models/models.dart';

/// Paso 1 del cliente: qué se rompió.
///
/// La grilla se adapta sola: dos columnas en teléfono, cuatro en escritorio.
/// Cada tarjeta lleva la lista de subcategorías debajo del nombre, porque la
/// duda más común no es "qué rubro es" sino "¿esto entra acá?".
class CategoryPickerScreen extends ConsumerWidget {
  const CategoryPickerScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final columns = isWide(context) ? 3 : 2;

    return Scaffold(
      appBar: AppBar(title: const Text('¿Qué necesitás resolver?')),
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 960),
            child: GridView.builder(
              padding: const EdgeInsets.all(AppSpacing.md),
              gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
                crossAxisCount: columns,
                mainAxisSpacing: AppSpacing.md,
                crossAxisSpacing: AppSpacing.md,
                childAspectRatio: 1.05,
              ),
              itemCount: ServiceCategory.values.length,
              itemBuilder: (context, i) {
                final category = ServiceCategory.values[i];
                return _CategoryCard(
                  category: category,
                  onTap: () => _openServiceSheet(context, ref, category),
                );
              },
            ),
          ),
        ),
      ),
    );
  }

  Future<void> _openServiceSheet(BuildContext context, WidgetRef ref, ServiceCategory category) {
    return showModalBottomSheet(
      context: context,
      isScrollControlled: true,
      backgroundColor: AppColors.white,
      shape: const RoundedRectangleBorder(
        borderRadius: BorderRadius.vertical(top: Radius.circular(20)),
      ),
      builder: (_) => _ServiceListSheet(category: category),
    );
  }
}

class _CategoryCard extends StatelessWidget {
  const _CategoryCard({required this.category, required this.onTap});

  final ServiceCategory category;
  final VoidCallback onTap;

  static const _icons = {
    'plumbing': Icons.plumbing_outlined,
    'bolt': Icons.bolt_outlined,
    'ac_unit': Icons.ac_unit_outlined,
    'format_paint': Icons.format_paint_outlined,
    'cleaning_services': Icons.cleaning_services_outlined,
    'handyman': Icons.handyman_outlined,
  };

  @override
  Widget build(BuildContext context) {
    return Card(
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Container(
                padding: const EdgeInsets.all(10),
                decoration: BoxDecoration(
                  color: AppColors.steelSoft,
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Icon(_icons[category.icon.name], color: AppColors.steel, size: 26),
              ),
              const Spacer(),
              Text(category.label, style: AppTypography.bodyStrong),
              const SizedBox(height: AppSpacing.xs),
              Text(category.hint, style: AppTypography.caption, maxLines: 2, overflow: TextOverflow.ellipsis),
            ],
          ),
        ),
      ),
    );
  }
}

/// Subcategorías con el precio de referencia. Mostrar el precio acá evita el
/// abandono a mitad del formulario.
class _ServiceListSheet extends ConsumerWidget {
  const _ServiceListSheet({required this.category});

  final ServiceCategory category;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final services = ref.watch(servicesByCategoryProvider(category));

    return DraggableScrollableSheet(
      expand: false,
      initialChildSize: 0.6,
      maxChildSize: 0.9,
      builder: (context, controller) => Column(
        children: [
          const SizedBox(height: AppSpacing.sm),
          Container(width: 40, height: 4, decoration: BoxDecoration(
            color: AppColors.line, borderRadius: BorderRadius.circular(2))),
          Padding(
            padding: const EdgeInsets.all(AppSpacing.md),
            child: Align(
              alignment: Alignment.centerLeft,
              child: Text(category.label, style: AppTypography.title),
            ),
          ),
          Expanded(
            child: services.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => _ErrorState(
                message: 'No pudimos cargar los servicios.',
                onRetry: () => ref.invalidate(servicesByCategoryProvider(category)),
              ),
              data: (items) => ListView.separated(
                controller: controller,
                padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md),
                itemCount: items.length,
                separatorBuilder: (_, __) => const Divider(height: 1),
                itemBuilder: (_, i) {
                  final s = items[i];
                  return ListTile(
                    contentPadding: const EdgeInsets.symmetric(vertical: 6),
                    title: Text(s.name, style: AppTypography.bodyStrong),
                    subtitle: Text(s.description, style: AppTypography.caption),
                    trailing: Column(
                      mainAxisAlignment: MainAxisAlignment.center,
                      crossAxisAlignment: CrossAxisAlignment.end,
                      children: [
                        Text(_money(s.basePrice, s.currency), style: AppTypography.bodyStrong),
                        Text(s.isEstimate ? 'estimado' : 'precio cerrado', style: AppTypography.caption),
                      ],
                    ),
                    onTap: () => context.push('/nueva-solicitud/${s.id}'),
                  );
                },
              ),
            ),
          ),
        ],
      ),
    );
  }
}

String _money(int cents, String currency) {
  final value = cents / 100;
  return '\$${value.toStringAsFixed(0)} $currency';
}

class _ErrorState extends StatelessWidget {
  const _ErrorState({required this.message, required this.onRetry});
  final String message;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Center(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(message, style: AppTypography.body),
            const SizedBox(height: AppSpacing.sm),
            TextButton(onPressed: onRetry, child: const Text('Reintentar')),
          ],
        ),
      );
}
