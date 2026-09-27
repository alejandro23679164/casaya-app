import 'dart:async';
import 'package:cloud_functions/cloud_functions.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme.dart';

/// Ingreso por teléfono con OTP — reemplaza el placeholder.
///
/// Es la puerta de entrada de todo el resto de la app: sin esto, nadie llega
/// a pedir un servicio, porque el backend exige `phoneVerified` en el token
/// antes de dejar crear una solicitud (`requireVerifiedClient` en
/// `requests.ts`). El flujo de Firebase ya deja esa marca sola — no hace
/// falta pedirle nada aparte al backend para eso.
///
/// Dos pasos, una sola pantalla: pedir el número, después pedir el código.
/// `verificationCompleted` cubre el caso feliz de Android (detección
/// automática del SMS, sin que la persona tenga que tipear nada); el resto
/// de las plataformas cae en el flujo manual de siempre.
class PhoneAuthScreen extends StatefulWidget {
  const PhoneAuthScreen({super.key});

  @override
  State<PhoneAuthScreen> createState() => _PhoneAuthScreenState();
}

enum _Step { phone, code }

class _PhoneAuthScreenState extends State<PhoneAuthScreen> {
  final _phoneCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();

  _Step _step = _Step.phone;
  String? _verificationId;
  int? _resendToken;
  bool _busy = false;
  String? _error;
  Timer? _resendTimer;
  int _resendSecondsLeft = 0;

  @override
  void dispose() {
    _phoneCtrl.dispose();
    _codeCtrl.dispose();
    _resendTimer?.cancel();
    super.dispose();
  }

  /// Arma el número en formato E.164. Argentina por defecto porque es donde
  /// arranca la operación; cambiar esto a un selector de país real es
  /// trabajo de una sesión aparte, no de esta pantalla mínima.
  String get _e164Phone {
    final digits = _phoneCtrl.text.replaceAll(RegExp(r'\D'), '');
    return '+549$digits';
  }

  Future<void> _sendCode() async {
    setState(() { _busy = true; _error = null; });
    try {
      await FirebaseAuth.instance.verifyPhoneNumber(
        phoneNumber: _e164Phone,
        timeout: const Duration(seconds: 60),
        forceResendingToken: _resendToken,
        verificationCompleted: (credential) async {
          // Android con detección automática: nunca llega a pedir el código.
          await _completeSignIn(credential);
        },
        verificationFailed: (e) {
          if (!mounted) return;
          setState(() { _busy = false; _error = _humanizeAuthError(e); });
        },
        codeSent: (verificationId, resendToken) {
          if (!mounted) return;
          setState(() {
            _step = _Step.code;
            _verificationId = verificationId;
            _resendToken = resendToken;
            _busy = false;
          });
          _startResendCountdown();
        },
        codeAutoRetrievalTimeout: (verificationId) {
          _verificationId = verificationId;
        },
      );
    } on FirebaseAuthException catch (e) {
      setState(() { _busy = false; _error = _humanizeAuthError(e); });
    }
  }

  Future<void> _confirmCode() async {
    if (_verificationId == null) return;
    setState(() { _busy = true; _error = null; });
    final credential = PhoneAuthProvider.credential(
      verificationId: _verificationId!,
      smsCode: _codeCtrl.text.trim(),
    );
    await _completeSignIn(credential);
  }

  Future<void> _completeSignIn(PhoneAuthCredential credential) async {
    try {
      await FirebaseAuth.instance.signInWithCredential(credential);

      // El primer inicio de sesión no tiene todavía documento en `users/`;
      // se crea (o se confirma) acá antes de dejar avanzar a la app. Sin
      // esto, la primera pantalla después del login pega contra un
      // documento que no existe.
      await FirebaseFunctions.instanceFor(region: 'southamerica-east1')
          .httpsCallable('ensureUserProfile')
          .call();

      // No hace falta navegar a mano: el `redirect` de go_router ya
      // reacciona al cambio de sesión y saca de `/ingresar` solo.
    } on FirebaseAuthException catch (e) {
      if (!mounted) return;
      setState(() { _busy = false; _error = _humanizeAuthError(e); });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Entraste, pero no pudimos preparar tu perfil. Probá de nuevo.';
      });
    }
  }

  void _startResendCountdown() {
    _resendTimer?.cancel();
    setState(() => _resendSecondsLeft = 30);
    _resendTimer = Timer.periodic(const Duration(seconds: 1), (t) {
      if (!mounted) return;
      setState(() => _resendSecondsLeft--);
      if (_resendSecondsLeft <= 0) t.cancel();
    });
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 420),
            child: Padding(
              padding: const EdgeInsets.all(AppSpacing.lg),
              child: _step == _Step.phone ? _phoneStep() : _codeStep(),
            ),
          ),
        ),
      ),
    );
  }

  Widget _phoneStep() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Tu número de teléfono', style: AppTypography.display),
        const SizedBox(height: AppSpacing.sm),
        const Text(
          'Te mandamos un código por SMS para confirmar que sos vos.',
          style: AppTypography.body,
        ),
        const SizedBox(height: AppSpacing.lg),
        TextField(
          controller: _phoneCtrl,
          keyboardType: TextInputType.phone,
          autofocus: true,
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => _canSendCode ? _sendCode() : null,
          decoration: const InputDecoration(
            prefixText: '+54 9  ',
            hintText: '11 2345 6789',
          ),
        ),
        const SizedBox(height: AppSpacing.sm),
        if (_error != null) _ErrorBanner(_error!),
        const SizedBox(height: AppSpacing.md),
        FilledButton(
          onPressed: _canSendCode && !_busy ? _sendCode : null,
          child: _busy
              ? const SizedBox(width: 20, height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Enviar código'),
        ),
      ],
    );
  }

  bool get _canSendCode => _phoneCtrl.text.replaceAll(RegExp(r'\D'), '').length >= 10;

  Widget _codeStep() {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Ingresá el código', style: AppTypography.display),
        const SizedBox(height: AppSpacing.sm),
        Text('Te lo mandamos por SMS a $_e164Phone.', style: AppTypography.body),
        const SizedBox(height: AppSpacing.lg),
        TextField(
          controller: _codeCtrl,
          keyboardType: TextInputType.number,
          maxLength: 6,
          autofocus: true,
          inputFormatters: [FilteringTextInputFormatter.digitsOnly],
          style: AppTypography.numeric.copyWith(fontSize: 28, letterSpacing: 10),
          textAlign: TextAlign.center,
          decoration: const InputDecoration(counterText: '', hintText: '––––––'),
          onChanged: (_) => setState(() {}),
          onSubmitted: (_) => _codeCtrl.text.length == 6 ? _confirmCode() : null,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (_error != null) _ErrorBanner(_error!),
        const SizedBox(height: AppSpacing.md),
        FilledButton(
          onPressed: _codeCtrl.text.length == 6 && !_busy ? _confirmCode : null,
          child: _busy
              ? const SizedBox(width: 20, height: 20,
                  child: CircularProgressIndicator(strokeWidth: 2, color: Colors.white))
              : const Text('Confirmar'),
        ),
        const SizedBox(height: AppSpacing.sm),
        Center(
          child: TextButton(
            onPressed: _resendSecondsLeft > 0 || _busy ? null : _sendCode,
            child: Text(
              _resendSecondsLeft > 0 ? 'Reenviar en ${_resendSecondsLeft}s' : 'Reenviar código',
            ),
          ),
        ),
        Center(
          child: TextButton(
            onPressed: _busy ? null : () => setState(() { _step = _Step.phone; _error = null; }),
            child: const Text('Cambiar número'),
          ),
        ),
      ],
    );
  }
}

class _ErrorBanner extends StatelessWidget {
  const _ErrorBanner(this.message);
  final String message;

  @override
  Widget build(BuildContext context) => Container(
        padding: const EdgeInsets.all(AppSpacing.sm),
        decoration: BoxDecoration(
          color: AppColors.alarm.withOpacity(0.08),
          borderRadius: BorderRadius.circular(10),
        ),
        child: Text(message, style: AppTypography.caption.copyWith(color: AppColors.alarm)),
      );
}

/// Mensajes en criollo para los códigos que Firebase Auth devuelve más
/// seguido durante pruebas — el resto cae en un genérico razonable.
String _humanizeAuthError(FirebaseAuthException e) {
  switch (e.code) {
    case 'invalid-phone-number':
      return 'Ese número no parece válido. Revisalo.';
    case 'too-many-requests':
      return 'Demasiados intentos. Esperá un rato y probá de nuevo.';
    case 'invalid-verification-code':
      return 'El código no coincide. Fijate bien y probá de nuevo.';
    case 'session-expired':
      return 'El código venció. Pedí uno nuevo.';
    case 'quota-exceeded':
      return 'Se acabó la cuota de SMS de prueba por hoy.';
    default:
      return 'Algo no funcionó. Probá de nuevo en un momento.';
  }
}
