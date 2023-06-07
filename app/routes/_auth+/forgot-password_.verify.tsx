import { conform, useForm } from '@conform-to/react'
import { getFieldsetConstraint, parse } from '@conform-to/zod'
import {
	json,
	redirect,
	type DataFunctionArgs,
	type V2_MetaFunction,
} from '@remix-run/node'
import {
	Form,
	Link,
	useActionData,
	useFormAction,
	useLoaderData,
	useNavigation,
} from '@remix-run/react'
import { z } from 'zod'
import { GeneralErrorBoundary } from '~/components/error-boundary.tsx'
import { prisma } from '~/utils/db.server.ts'
import { Button, ErrorList, Field } from '~/utils/forms.tsx'
import { commitSession, getSession } from '~/utils/session.server.ts'
import { emailSchema, usernameSchema } from '~/utils/user-validation.ts'
import {
	forgotPasswordOTPQueryParam,
	forgotPasswordVerificationTargetQueryParam,
	verificationType,
} from './forgot-password.tsx'
import { resetPasswordUsernameSessionKey } from './reset-password.tsx'
import { verifyTOTP } from '~/utils/totp.server.ts'
import invariant from 'tiny-invariant'

const verifySchema = z.object({
	[forgotPasswordVerificationTargetQueryParam]: z.union([
		emailSchema,
		usernameSchema,
	]),
	[forgotPasswordOTPQueryParam]: z.string().min(6).max(6),
})

export async function loader({ request }: DataFunctionArgs) {
	const params = new URL(request.url).searchParams
	if (!params.has(forgotPasswordOTPQueryParam)) {
		// we don't want to show an error message on page load if the otp hasn't be
		// prefilled in yet, so we'll send a response with an empty submission.
		return json({
			status: 'idle',
			submission: {
				intent: '',
				payload: Object.fromEntries(params),
				error: {},
			},
		} as const)
	}
	return validate(request, params)
}

export async function action({ request }: DataFunctionArgs) {
	return validate(request, await request.formData())
}

async function validate(request: Request, body: FormData | URLSearchParams) {
	const submission = await parse(body, {
		schema: () =>
			verifySchema.superRefine(async (data, ctx) => {
				const verification = await prisma.verification.findFirst({
					where: {
						type: verificationType,
						verificationTarget: data.usernameOrEmail,
						otp: data.code,
					},
					select: {
						algorithm: true,
						secretKey: true,
						validSeconds: true,
					},
				})
				if (!verification) {
					ctx.addIssue({
						path: [forgotPasswordOTPQueryParam],
						code: z.ZodIssueCode.custom,
						message: `Invalid code`,
					})
					return
				}
				const result = verifyTOTP(
					{ otp: data.code, key: verification.secretKey },
					{
						algorithm: verification.algorithm,
						validSeconds: verification.validSeconds,
						window: 50,
					},
				)
				if (!result) {
					ctx.addIssue({
						path: [forgotPasswordOTPQueryParam],
						code: z.ZodIssueCode.custom,
						message: `Invalid code`,
					})
					return
				}
			}),
		acceptMultipleErrors: () => true,
		async: true,
	})

	if (submission.intent !== 'submit') {
		return json({ status: 'idle', submission } as const)
	}
	if (!submission.value) {
		return json(
			{
				status: 'error',
				submission,
			} as const,
			{ status: 400 },
		)
	}
	await prisma.verification.deleteMany({
		where: {
			type: verificationType,
			verificationTarget: submission.value.usernameOrEmail,
			otp: submission.value.code,
		},
	})
	const { usernameOrEmail } = submission.value
	const user = await prisma.user.findFirst({
		where: { OR: [{ email: usernameOrEmail }, { username: usernameOrEmail }] },
		select: { email: true, username: true },
	})
	// this should not be possible...
	invariant(user, 'User not found')

	const session = await getSession(request.headers.get('Cookie'))
	session.set(resetPasswordUsernameSessionKey, user.username)
	return redirect('/reset-password', {
		headers: { 'Set-Cookie': await commitSession(session) },
	})
}

export const meta: V2_MetaFunction = () => {
	return [{ title: 'Verify Password Recovery for Epic Notes' }]
}

export default function ForgotPasswordVerifyRoute() {
	const data = useLoaderData<typeof loader>()
	const formAction = useFormAction()
	const navigation = useNavigation()
	const isSubmitting = navigation.formAction === formAction
	const actionData = useActionData<typeof action>()

	const [form, fields] = useForm({
		id: 'forgot-password-verify-form',
		constraint: getFieldsetConstraint(verifySchema),
		lastSubmission: actionData?.submission ?? data.submission,
		onValidate({ formData }) {
			return parse(formData, { schema: verifySchema })
		},
		shouldRevalidate: 'onBlur',
	})

	return (
		<div className="container mx-auto pb-32 pt-20">
			<div className="flex flex-col justify-center">
				<>
					<div className="text-center">
						<h1 className="text-h1">Check your email</h1>
						<p className="mt-3 text-body-md text-night-200">
							We've sent you a code to verify your password reset.
						</p>
					</div>
					<Form
						method="POST"
						{...form.props}
						className="mx-auto mt-16 min-w-[368px] max-w-sm"
					>
						<Field
							labelProps={{
								htmlFor: fields.usernameOrEmail.id,
								children: 'Username or Email',
							}}
							inputProps={conform.input(fields.usernameOrEmail)}
							errors={fields.usernameOrEmail.errors}
						/>
						<Field
							labelProps={{
								htmlFor: fields.code.id,
								children: 'Code',
							}}
							inputProps={{ ...conform.input(fields.code), autoFocus: true }}
							errors={fields.code.errors}
						/>
						<ErrorList errors={form.errors} id={form.errorId} />

						<div className="mt-6">
							<Button
								className="w-full"
								size="md"
								variant="primary"
								status={isSubmitting ? 'pending' : actionData?.status ?? 'idle'}
								type="submit"
								disabled={isSubmitting}
							>
								Submit
							</Button>
						</div>
					</Form>
				</>
				<Link to="/login" className="mt-11 text-center text-body-sm font-bold">
					Back to Login
				</Link>
			</div>
		</div>
	)
}

export function ErrorBoundary() {
	return <GeneralErrorBoundary />
}
