import GuestJoin from '@/components/GuestJoin';

export default async function GuestJoinPage({
  params,
}: {
  params: Promise<{ code: string }>;
}) {
  const { code } = await params;
  return <GuestJoin code={code} />;
}
