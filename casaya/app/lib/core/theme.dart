import 'package:flutter/material.dart';

/// Sistema de diseño de CasaYa.
///
/// El producto entra en la casa de alguien con un problema y un desconocido en
/// la puerta. La paleta parte de ahí: azul de herramienta y taller como base
/// —sobrio, nada festivo—, ámbar reservado exclusivamente para los momentos de
/// seguridad (el PIN, la verificación) y rojo solo para el pánico. Si un color
/// de alerta aparece en cualquier otro lado, pierde su significado.
class AppColors {
  static const ink = Color(0xFF0F2233);        // azul casi negro, texto principal
  static const steel = Color(0xFF18628F);      // azul de acción
  static const steelSoft = Color(0xFFE3EEF6);
  static const trust = Color(0xFF1F7A5C);      // verde de confirmado
  static const signal = Color(0xFFFFB020);     // ámbar: solo seguridad y PIN
  static const alarm = Color(0xFFC62828);      // rojo: solo pánico
  static const slate = Color(0xFF64798A);      // texto secundario
  static const line = Color(0xFFDDE4E9);
  static const surface = Color(0xFFF2F5F7);
  static const white = Color(0xFFFFFFFF);
}

class AppSpacing {
  static const xs = 4.0;
  static const sm = 8.0;
  static const md = 16.0;
  static const lg = 24.0;
  static const xl = 40.0;
}

/// Escala tipográfica: Sora para títulos (geométrica, ancha, se lee de lejos
/// en una pantalla sostenida con una mano mientras se sube una escalera),
/// Inter para el resto.
class AppTypography {
  static const display = TextStyle(
      fontFamily: 'Sora', fontSize: 30, height: 1.15, fontWeight: FontWeight.w700, letterSpacing: -0.6);
  static const title = TextStyle(
      fontFamily: 'Sora', fontSize: 21, height: 1.2, fontWeight: FontWeight.w600, letterSpacing: -0.3);
  static const body = TextStyle(fontFamily: 'Inter', fontSize: 15, height: 1.5);
  static const bodyStrong = TextStyle(fontFamily: 'Inter', fontSize: 15, height: 1.5, fontWeight: FontWeight.w600);
  static const caption = TextStyle(fontFamily: 'Inter', fontSize: 13, height: 1.4, color: AppColors.slate);
  /// Dígitos tabulares para el PIN y los importes: no bailan al cambiar.
  static const numeric = TextStyle(
      fontFamily: 'Sora', fontSize: 34, fontWeight: FontWeight.w700, letterSpacing: 10,
      fontFeatures: [FontFeature.tabularFigures()]);
}

ThemeData buildAppTheme() {
  final base = ThemeData.light(useMaterial3: true);

  return base.copyWith(
    scaffoldBackgroundColor: AppColors.surface,
    colorScheme: const ColorScheme.light(
      primary: AppColors.steel,
      onPrimary: AppColors.white,
      secondary: AppColors.trust,
      surface: AppColors.white,
      onSurface: AppColors.ink,
      error: AppColors.alarm,
    ),
    textTheme: base.textTheme.copyWith(
      displaySmall: AppTypography.display,
      titleLarge: AppTypography.title,
      bodyMedium: AppTypography.body,
      bodySmall: AppTypography.caption,
    ),
    appBarTheme: const AppBarTheme(
      backgroundColor: AppColors.white,
      foregroundColor: AppColors.ink,
      elevation: 0,
      centerTitle: false,
      titleTextStyle: AppTypography.title,
    ),
    cardTheme: CardTheme(
      color: AppColors.white,
      elevation: 0,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: const BorderSide(color: AppColors.line),
      ),
      margin: EdgeInsets.zero,
    ),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        minimumSize: const Size.fromHeight(52),   // objetivo táctil generoso: se usa con guantes o apuro
        shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12)),
        textStyle: AppTypography.bodyStrong,
      ),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: AppColors.white,
      border: OutlineInputBorder(
        borderRadius: BorderRadius.circular(12),
        borderSide: const BorderSide(color: AppColors.line),
      ),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 14),
    ),
    dividerColor: AppColors.line,
  );
}

/// Punto de corte para adaptar la misma pantalla a teléfono y a escritorio web.
bool isWide(BuildContext context) => MediaQuery.sizeOf(context).width >= 900;
